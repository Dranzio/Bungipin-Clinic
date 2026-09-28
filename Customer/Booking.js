// ── BOOKING CONTROLLER (Dynamic Doctor Schedules, Slots & Philippine Payments) ─────────
// MOCK_SCHEDULES / generateLocalSlots() / timeStrToMinutes() removed: the
// mock schedule was keyed by fake doctor_id 1/2/3, which no longer matches
// the real employee_id values (3/4/6) now that /api/doctors and
// /api/doctors/:id/available-slots return live DB data. Silently falling
// back to a mock schedule under the wrong doctor's real ID/name was worse
// than just telling the user to retry.
const API_BASE_URL = window.BACKEND_API_BASE_URL || '';

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

// Strip characters that have no business in these fields, and cap length
function sanitizeInput(str, maxLen = 100) {
    return String(str ?? '').trim().replace(/[<>]/g, '').slice(0, maxLen);
}

// Format validators — return true/false
function isValidPHMobile(value) {
    return /^09\d{9}$/.test(value.replace(/\s|-/g, ''));
}
function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
function isValidCardNumber(value) {
    const digits = value.replace(/\s/g, '');
    return /^\d{13,19}$/.test(digits);
}
function isValidExpiry(value) {
    const match = /^(\d{2})\/(\d{2})$/.exec(value.trim());
    if (!match) return false;
    const month = Number(match[1]);
    if (month < 1 || month > 12) return false;
    const year = 2000 + Number(match[2]);
    const now = new Date();
    const expiryDate = new Date(year, month, 0);
    return expiryDate >= new Date(now.getFullYear(), now.getMonth(), 1);
}
function isValidCVV(value) {
    return /^\d{3,4}$/.test(value.trim());
}
function isValidCardLast4(value) {
    return /^\d{4}$/.test(value.trim());
}
function isValidNameField(value) {
    return /^[a-zA-ZñÑ.'\- ]{2,60}$/.test(value.trim());
}

// ── State Management ────────────────────────────────────────────────────────
let availableServices = [];
let availableDoctors  = [];
let selectedServices  = []; // Array of { service_id, label, price, duration_minutes }
let selectedDoctorId  = null;
let selectedDateValue = '';
let selectedStartTime = '';
let selectedEndTime   = '';
let currentPaymentChannel = 'gcash';

// Fallback duration estimator
function getEstimatedDuration(service) {
    if (service.duration_minutes) return Number(service.duration_minutes);
    const lbl = String(service.label || '').toLowerCase();
    if (lbl.includes('clean') || lbl.includes('prophylaxis')) return 45;
    if (lbl.includes('whiten')) return 60;
    if (lbl.includes('root') || lbl.includes('canal')) return 90;
    if (lbl.includes('extract') || lbl.includes('surgery')) return 45;
    if (lbl.includes('pasta') || lbl.includes('filling')) return 30;
    if (lbl.includes('check') || lbl.includes('consult')) return 30;
    return 30;
}

function formatDuration(minutes) {
    if (!minutes || minutes <= 0) return '0 mins';
    const hrs = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hrs > 0 && mins > 0) return `${hrs} hr ${mins} mins`;
    if (hrs > 0) return `${hrs} hr${hrs > 1 ? 's' : ''}`;
    return `${mins} mins`;
}

function format12Hour(timeStr) {
    if (!timeStr) return '';
    const [hStr, mStr] = timeStr.split(':');
    let h = parseInt(hStr, 10);
    const m = mStr || '00';
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    h = h ? h : 12;
    return `${h}:${m} ${ampm}`;
}

function calculateEndTime(startTimeStr, durationMinutes) {
    const [h, m] = startTimeStr.split(':').map(Number);
    const totalMinutes = h * 60 + m + durationMinutes;
    const endH = Math.floor(totalMinutes / 60);
    const endM = totalMinutes % 60;
    return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00`;
}

document.addEventListener('DOMContentLoaded', () => {
    initCalendar();
    initDoctorSelection();
    loadServices();
    loadDoctors();
    initBookingForm();
    initPaymentChannels();
});

// ── 1. Load Services from Database ──────────────────────────────────────────
async function loadServices() {
    const serviceGrid = document.getElementById('service-grid');
    if (!serviceGrid) return;

    serviceGrid.innerHTML = '<p class="col-span-full text-center font-bold text-[#2c3e2b] py-8"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading clinic services...</p>';

    try {
        const token = localStorage.getItem('userToken');
        const response = await fetch(`${API_BASE_URL}/api/services`, {
            headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });

        if (response.ok) {
            const data = await response.json();
            availableServices = data.filter(s => s.is_available !== false && s.is_available !== 0);
            renderServiceCards(availableServices);
        } else {
            throw new Error("Unable to fetch services");
        }
    } catch (err) {
        console.warn("Using sample services fallback:", err);
        availableServices = [
            { service_id: 1, label: 'Dental Checkup & Consultation', price: 500, duration_minutes: 30, icon: '../assets/Checkup.png' },
            { service_id: 2, label: 'Oral Prophylaxis (Cleaning)', price: 1500, duration_minutes: 45, icon: '../assets/cleaning.png' },
            { service_id: 3, label: 'Composite Tooth Filling (Pasta)', price: 1200, duration_minutes: 30, icon: '../assets/pasta.png' },
            { service_id: 4, label: 'Laser Teeth Whitening', price: 4500, duration_minutes: 60, icon: '../assets/whitening.png' },
            { service_id: 5, label: 'Tooth Extraction', price: 1800, duration_minutes: 45, icon: '../assets/logo.png' },
            { service_id: 6, label: 'Root Canal Therapy', price: 6500, duration_minutes: 90, icon: '../assets/logo.png' }
        ];
        renderServiceCards(availableServices);
    }
}

function fallbackIcon(label) {
    const l = String(label).toLowerCase();
    if (l.includes('clean') || l.includes('prophylaxis')) return '../assets/cleaning.png';
    if (l.includes('pasta') || l.includes('filling')) return '../assets/pasta.png';
    if (l.includes('check') || l.includes('consult')) return '../assets/Checkup.png';
    if (l.includes('whiten')) return '../assets/whitening.png';
    return '../assets/logowithtitle.png';
}

function renderServiceCards(services) {
    const serviceGrid = document.getElementById('service-grid');
    if (!serviceGrid) return;
    serviceGrid.innerHTML = '';

    services.forEach(service => {
        const isSelected = selectedServices.some(s => s.service_id == service.service_id);
        const card = document.createElement('div');
        const duration = getEstimatedDuration(service);

        card.className = `flex flex-col w-full max-w-[240px] h-[270px] justify-between items-center text-center rounded-2xl border-2 transition-all duration-200 cursor-pointer p-4 pt-7 relative shadow-sm hover:scale-[1.02] overflow-hidden ${
            isSelected ? 'bg-[#D7E3A5] border-[#667733] ring-2 ring-[#667733]' : 'bg-white border-black hover:bg-[#F7F5EE]'
        }`;

        card.dataset.serviceId = service.service_id;

        const imgSrc = (service.icon && (/^(\/|https?:\/\/|\.\.\/assets\/)/.test(service.icon)))
            ? service.icon
            : fallbackIcon(service.label);

        card.innerHTML = `
            <div class="absolute top-2.5 right-2.5 w-6 h-6 rounded-full border-2 border-black flex items-center justify-center ${isSelected ? 'bg-[#667733] text-white' : 'bg-white text-transparent'}">
                <i class="fa-solid fa-check text-xs"></i>
            </div>

            <div class="absolute top-2.5 left-2.5 bg-amber-100 border border-amber-500/30 text-amber-900 text-[10px] font-extrabold px-2 py-0.5 rounded-full flex items-center gap-1">
                <i class="fa-regular fa-clock text-[9px]"></i> ${duration}m
            </div>

            <h3 class="font-extrabold text-sm sm:text-base break-words w-full text-[#2A1001] line-clamp-2 px-2 mt-5">
                ${escapeHtml(service.label)}
            </h3>

            <img src="${imgSrc}" class="w-16 h-16 object-contain my-1" alt="${escapeHtml(service.label)}" onerror="this.src='../assets/logowithtitle.png'">

            <div class="w-full pt-2 border-t border-[#2A1001]/10 flex justify-between items-center px-2">
                <span class="text-[10px] font-bold text-[#2A1001]/60 uppercase">Price:</span>
                <span class="font-black text-sm text-[#2A1001]">₱${Number(service.price).toLocaleString()}</span>
            </div>
        `;

        card.addEventListener('click', () => toggleServiceSelection(service));
        serviceGrid.appendChild(card);
    });

    updateLiveCalculations();
}

function toggleServiceSelection(service) {
    const index = selectedServices.findIndex(s => s.service_id == service.service_id);
    const duration = getEstimatedDuration(service);

    if (index > -1) {
        selectedServices.splice(index, 1);
    } else {
        selectedServices.push({
            service_id: service.service_id,
            label: service.label,
            price: Number(service.price || 0),
            duration_minutes: duration
        });
    }
    renderServiceCards(availableServices);

    if (selectedDoctorId && selectedDateValue) {
        fetchAvailableSlotsForDoctor(selectedDoctorId, selectedDateValue);
    }
}

function updateLiveCalculations() {
    const totalAmount = selectedServices.reduce((sum, s) => sum + s.price, 0);
    const totalMinutes = selectedServices.reduce((sum, s) => sum + (s.duration_minutes || 30), 0);

    const displayTotal = document.getElementById('liveTotalDisplay');
    const displayDuration = document.getElementById('liveDurationDisplay');
    const onlineAmountText = document.getElementById('onlinePayAmountText');

    if (displayTotal) displayTotal.textContent = `₱${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    if (onlineAmountText) onlineAmountText.textContent = `₱${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    if (displayDuration) displayDuration.textContent = formatDuration(totalMinutes);

    const slotInfoBadge = document.getElementById('slotInfoBadge');
    if (slotInfoBadge) {
        slotInfoBadge.textContent = totalMinutes > 0 ? `Est. Session Window: ${formatDuration(totalMinutes)}` : '';
    }
}

// ── 2. Load Attending Dentists ──────────────────────────────────────────────
async function loadDoctors() {
    const doctorSelect = document.getElementById('doctorSelect');
    if (!doctorSelect) return;

    try {
        const token = localStorage.getItem('userToken');
        const response = await fetch(`${API_BASE_URL}/api/doctors`, {
            headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });

        if (response.ok) {
            availableDoctors = await response.json();
            populateDoctorDropdown(availableDoctors);
        } else {
            throw new Error();
        }
    } catch {
        availableDoctors = [
            { doctor_id: 1, name: 'Dr. Ramon Cruz', position: 'Dentist' },
            { doctor_id: 2, name: 'Dr. Liza Tan', position: 'Dentist' },
            { doctor_id: 3, name: 'Dr. Maria Gomez', position: 'Dentist' }
        ];
        populateDoctorDropdown(availableDoctors);
    }
}

function populateDoctorDropdown(doctors) {
    const doctorSelect = document.getElementById('doctorSelect');
    if (!doctorSelect) return;

    doctorSelect.innerHTML = '<option value="" disabled selected style="color:#9CA3AF;">-- Select Your Attending Dentist --</option>';
    doctors.forEach(doc => {
        const opt = document.createElement('option');
        opt.value = doc.doctor_id;
        opt.textContent = `${doc.name}`;
        doctorSelect.appendChild(opt);
    });

    doctorSelect.selectedIndex = 0;
    selectedDoctorId = null;
    doctorSelect.classList.add('text-gray-400');
    doctorSelect.classList.remove('text-[#2A1001]');
    const docInput = document.getElementById('selected-doctor-id');
    if (docInput) docInput.value = '';
}

function initDoctorSelection() {
    const doctorSelect = document.getElementById('doctorSelect');
    if (!doctorSelect) return;

    doctorSelect.addEventListener('change', (e) => {
        selectedDoctorId = e.target.value ? Number(e.target.value) : null;
        const docInput = document.getElementById('selected-doctor-id');
        if (docInput) docInput.value = selectedDoctorId || '';

        doctorSelect.classList.toggle('text-gray-400', !selectedDoctorId);
        doctorSelect.classList.toggle('text-[#2A1001]', !!selectedDoctorId);

        if (selectedDateValue) {
            fetchAvailableSlotsForDoctor(selectedDoctorId, selectedDateValue);
        }
    });
}

// ── 3. Dynamic Time Slots Fetcher & Generator ───────────────────────────────
async function fetchAvailableSlotsForDoctor(doctorId, dateString) {
    const container = document.getElementById('timeSlotsContainer');
    if (!container) return;

    const totalMinutes = selectedServices.reduce((sum, s) => sum + (s.duration_minutes || 30), 0) || 30;

    container.innerHTML = `
        <div class="bg-white border border-black/10 rounded-2xl p-6 text-center text-gray-600">
            <i class="fa-solid fa-spinner fa-spin text-xl text-[#667733] mb-2 block"></i>
            Loading doctor schedule and available slots for ${escapeHtml(dateString)}...
        </div>
    `;

    try {
        const token = localStorage.getItem('userToken');
        const response = await fetch(`${API_BASE_URL}/api/doctors/${doctorId}/available-slots?date=${dateString}&duration=${totalMinutes}`, {
            headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });

        if (response.ok) {
            const data = await response.json();
            if (!data.is_working_day || !data.slots || data.slots.length === 0) {
                renderNoSlotsMessage(container, data.message || 'Dentist has no active duty on this day.');
            } else {
                renderDynamicSlots(container, data.slots, totalMinutes);
            }
        } else {
            throw new Error();
        }
    } catch {
        renderNoSlotsMessage(container, "Couldn't load this dentist's availability. Please check your connection and try again.");
    }
}

function renderNoSlotsMessage(container, msg) {
    container.innerHTML = `
        <div class="bg-amber-50 border border-amber-300 rounded-2xl p-6 text-center text-amber-900">
            <i class="fa-solid fa-calendar-xmark text-2xl text-amber-600 mb-2 block"></i>
            <p class="font-bold text-sm">${escapeHtml(msg)}</p>
            <p class="text-xs text-amber-800/80 mt-1">Please select another date on the calendar or choose a different dentist.</p>
        </div>
    `;
    selectedStartTime = '';
    selectedEndTime = '';
    document.getElementById('selected-time').value = '';
    document.getElementById('selected-end-time').value = '';
}

function renderDynamicSlots(container, slots, durationMinutes) {
    container.innerHTML = '';

    const amSlots = slots.filter(s => {
        const h = parseInt(s.time_slot.split(':')[0], 10);
        return h < 12;
    });

    const pmSlots = slots.filter(s => {
        const h = parseInt(s.time_slot.split(':')[0], 10);
        return h >= 12;
    });

    const durationLabel = formatDuration(durationMinutes);

    container.innerHTML = `
        <div class="flex flex-col sm:flex-row gap-4 justify-between w-full">
            <!-- AM Morning Column -->
            <div class="flex-1 flex flex-col gap-2.5">
                <h3 class="font-extrabold text-xs text-[#2A1001] uppercase tracking-wider flex items-center gap-1.5 pb-1 border-b border-[#2A1001]/10">
                    <i class="fa-solid fa-sun text-amber-500"></i> Morning (AM)
                </h3>
                <div class="flex flex-col gap-2" id="amSlotsList">
                    ${amSlots.length === 0 ? '<p class="text-xs text-gray-400 italic py-2">No morning slots available.</p>' : ''}
                </div>
            </div>

            <!-- PM Afternoon Column -->
            <div class="flex-1 flex flex-col gap-2.5">
                <h3 class="font-extrabold text-xs text-[#2A1001] uppercase tracking-wider flex items-center gap-1.5 pb-1 border-b border-[#2A1001]/10">
                    <i class="fa-solid fa-moon text-indigo-600"></i> Afternoon (PM)
                </h3>
                <div class="flex flex-col gap-2" id="pmSlotsList">
                    ${pmSlots.length === 0 ? '<p class="text-xs text-gray-400 italic py-2">No afternoon slots available.</p>' : ''}
                </div>
            </div>
        </div>
    `;

    const amList = document.getElementById('amSlotsList');
    const pmList = document.getElementById('pmSlotsList');

    function createSlotBtn(slot) {
        const isSelected = selectedStartTime === slot.time_slot;
        const btn = document.createElement('div');

        btn.dataset.time = slot.time_slot;
        btn.dataset.endTime = slot.end_time_slot;
        btn.dataset.disabled = slot.is_available ? 'false' : 'true';

        if (slot.is_available) {
            btn.className = `time-slot-btn flex flex-col w-full py-2.5 px-3 rounded-2xl border-2 items-center justify-center text-center font-bold text-xs transition active:scale-95 cursor-pointer shadow-sm ${
                isSelected
                    ? 'bg-[#667733] border-[#667733] text-white ring-2 ring-offset-2 ring-[#667733]'
                    : 'bg-white border-black text-[#2A1001] hover:bg-[#F0F5DE]'
            }`;
            btn.innerHTML = `
                <span class="text-xs sm:text-sm font-extrabold flex items-center gap-1.5">
                    ${isSelected ? '<i class="fa-solid fa-circle-check"></i>' : ''}
                    ${format12Hour(slot.time_slot)}
                </span>
                <span class="text-[10px] font-semibold mt-0.5 ${isSelected ? 'text-white/80' : 'text-gray-600'}">until ${format12Hour(slot.end_time_slot)} (${durationLabel})</span>
            `;

            btn.addEventListener('click', () => {
                selectedStartTime = slot.time_slot;
                selectedEndTime = slot.end_time_slot;
                document.getElementById('selected-time').value = selectedStartTime;
                document.getElementById('selected-end-time').value = selectedEndTime;
                renderDynamicSlots(container, slots, durationMinutes);
            });
        } else {
            btn.className = 'flex flex-col w-full py-2 px-3 bg-gray-100 rounded-2xl border border-gray-200 items-center justify-center text-center text-gray-400 text-xs cursor-not-allowed opacity-60 select-none';
            btn.innerHTML = `
                <span class="text-xs font-semibold line-through">${format12Hour(slot.time_slot)}</span>
                <span class="text-[9px] text-gray-400 font-medium">${escapeHtml(slot.reason || 'Unavailable')}</span>
            `;
        }

        return btn;
    }

    amSlots.forEach(s => amList.appendChild(createSlotBtn(s)));
    pmSlots.forEach(s => pmList.appendChild(createSlotBtn(s)));
}

// ──/ 4. Calendar Logic ───────────────────────────────────────────────────────
function initCalendar() {
    const monthYear = document.getElementById('month-year');
    const daysContainer = document.getElementById('days');
    const prevButton = document.getElementById('prev');
    const nextButton = document.getElementById('next');
    const PNote = document.getElementById('PNote');
    const CurrentCount = document.getElementById('current-count');

    const months = [
        'January', 'February', 'March', 'April', 'May', 'June', 'July',
        'August', 'September', 'October', 'November', 'December'
    ];

    let currentDate = new Date();
    let today = new Date();

    function isPastDate(dateString) {
        const selectedDay = new Date(`${dateString}T00:00:00`);
        const currentDay = new Date();
        currentDay.setHours(0, 0, 0, 0);
        return selectedDay < currentDay;
    }

    if (PNote && CurrentCount) {
        PNote.addEventListener('input', function () {
            CurrentCount.textContent = this.value.length;
        });
    }

    function renderCalendar(date) {
        const year = date.getFullYear();
        const month = date.getMonth();
        const firstDay = new Date(year, month, 1).getDay();
        const lastDay = new Date(year, month + 1, 0).getDate();

        if (monthYear) monthYear.textContent = `${months[month]} ${year}`;
        if (!daysContainer) return;
        daysContainer.innerHTML = '';

        const prevMonthLastDay = new Date(year, month, 0).getDate();
        for (let i = firstDay; i > 0; i--) {
            const dayDiv = document.createElement('div');
            dayDiv.className = 'w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center font-medium text-gray-300 select-none text-xs sm:text-sm';
            dayDiv.textContent = prevMonthLastDay - i + 1;
            daysContainer.appendChild(dayDiv);
        }

        for (let i = 1; i <= lastDay; i++) {
            const dayDiv = document.createElement('div');
            dayDiv.className = 'w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center font-bold text-xs sm:text-sm text-[#2A1001] cursor-pointer transition-all hover:bg-[#D7E3A5] hover:scale-110';
            dayDiv.textContent = i;

            if (i === today.getDate() && month === today.getMonth() && year === today.getFullYear()) {
                dayDiv.classList.add('border-2', 'border-[#667733]', 'bg-[#FDFCE9]');
            }

            const formattedMonth = String(month + 1).padStart(2, '0');
            const formattedDay = String(i).padStart(2, '0');
            const sqlDateStr = `${year}-${formattedMonth}-${formattedDay}`;

            if (isPastDate(sqlDateStr)) {
                dayDiv.className = 'w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center font-medium text-xs sm:text-sm bg-gray-100 text-gray-400 cursor-not-allowed select-none';
            } else {
                dayDiv.addEventListener('click', () => {
                    document.querySelectorAll('#days > div').forEach(d => d.classList.remove('bg-[#667733]', 'text-white'));
                    dayDiv.classList.add('bg-[#667733]', 'text-white');

                    selectedDateValue = sqlDateStr;
                    document.getElementById('selected-date').value = selectedDateValue;
                    if (selectedDoctorId) {
                        fetchAvailableSlotsForDoctor(selectedDoctorId, selectedDateValue);
                    }
                });
            }

            daysContainer.appendChild(dayDiv);
        }
    }

    if (prevButton) prevButton.addEventListener('click', () => { currentDate.setMonth(currentDate.getMonth() - 1); renderCalendar(currentDate); });
    if (nextButton) nextButton.addEventListener('click', () => { currentDate.setMonth(currentDate.getMonth() + 1); renderCalendar(currentDate); });

    renderCalendar(currentDate);
}

// ── 5. Philippine Payment Channels /Controller ───────────────────────────────
function initPaymentChannels() {
    const tabs = document.querySelectorAll('.channel-tab-btn');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const channel = tab.dataset.channel;
            currentPaymentChannel = channel;

            tabs.forEach(t => {
                t.classList.remove('border-[#667733]', 'bg-[#D7E3A5]/20', 'ring-1', 'ring-[#667733]');
                t.classList.add('border-black/15', 'bg-white');
            });
            tab.classList.remove('border-black/15', 'bg-white');
            tab.classList.add('border-[#667733]', 'bg-[#D7E3A5]/20', 'ring-1', 'ring-[#667733]');

            renderChannelContent(channel);
        });
    });

    renderChannelContent('gcash');
}

function renderChannelContent(channel) {
    const box = document.getElementById('channelContentBox');
    if (!box) return;

    const totalAmount = selectedServices.reduce((sum, s) => sum + s.price, 0);
    const refNumber = 'TXN-' + Math.floor(10000000 + Math.random() * 90000000);

    if (channel === 'gcash') {
        box.innerHTML = `
            <div class="flex flex-col sm:flex-row items-center sm:items-start gap-3">
                <div class="bg-blue-50 border border-[#005CEE]/30 rounded-xl p-2 flex flex-col items-center justify-center shrink-0 w-full sm:w-auto">
                    <img src="https://api.qrserver.com/v1/create-qr-code/?size=110x110&data=GCASH_PAYMENT_${refNumber}_${totalAmount}" class="w-24 h-24 sm:w-28 sm:h-28 rounded-lg border border-black/10 shadow-sm" alt="GCash QR">
                    <span class="text-[9px] font-black text-[#005CEE] mt-1 uppercase tracking-wider text-center">Scan via GCash</span>
                </div>
                <div class="flex-1 flex flex-col gap-2 w-full">
                    <div class="bg-[#005CEE]/10 p-2 rounded-xl border border-[#005CEE]/20 text-[11px] sm:text-xs text-[#005CEE] font-semibold leading-tight">
                        <i class="fa-solid fa-mobile-screen mr-1"></i> Merchant: <strong>DENTAL CLINIC INC.</strong><br>
                        <span>Account: <strong>0917-888-DENT (3368)</strong></span>
                    </div>
                    <div>
                        <label class="text-[11px] sm:text-xs font-bold text-[#2A1001] block mb-0.5">Your GCash Mobile No. <span class="text-red-500">*</span></label>
                        <input type="tel" id="gcash-mobile" placeholder="09XX XXX XXXX" maxlength="13" class="w-full bg-white border border-black/20 rounded-lg px-2.5 py-1.5 text-xs sm:text-sm font-semibold outline-none focus:ring-2 focus:ring-[#005CEE]">
                    </div>
                    <div>
                        <label class="text-[11px] sm:text-xs font-bold text-[#2A1001] block mb-0.5">GCash Reference No.:</label>
                        <input type="text" id="gcash-ref" value="${refNumber}" readonly class="w-full bg-gray-100 border border-black/15 rounded-lg px-2.5 py-1.5 text-xs sm:text-sm font-semibold outline-none text-gray-500 cursor-not-allowed">
                    </div>
                </div>
            </div>
        `;
        restrictToDigits(document.getElementById('gcash-mobile'), 11);
    } else if (channel === 'maya') {
        box.innerHTML = `
            <div class="flex flex-col sm:flex-row items-center sm:items-start gap-3">
                <div class="bg-emerald-50 border border-green-600/30 rounded-xl p-2 flex flex-col items-center justify-center shrink-0 w-full sm:w-auto">
                    <img src="https://api.qrserver.com/v1/create-qr-code/?size=110x110&data=MAYA_PAYMENT_${refNumber}_${totalAmount}" class="w-24 h-24 sm:w-28 sm:h-28 rounded-lg border border-black/10 shadow-sm" alt="Maya QR">
                    <span class="text-[9px] font-black text-green-700 mt-1 uppercase tracking-wider text-center">Scan via Maya</span>
                </div>
                <div class="flex-1 flex flex-col gap-2 w-full">
                    <div class="bg-green-50 p-2 rounded-xl border border-green-600/20 text-[11px] sm:text-xs text-green-800 font-semibold leading-tight">
                        <i class="fa-solid fa-wallet mr-1"></i> Maya Business Merchant: <strong>DENTAL CLINIC</strong><br>
                        <span>Account: <strong>@dentalclinicph</strong></span>
                    </div>
                    <div>
                        <label class="text-[11px] sm:text-xs font-bold text-[#2A1001] block mb-0.5">Your Maya Mobile No. <span class="text-red-500">*</span></label>
                        <input type="tel" id="maya-mobile" placeholder="09XX XXX XXXX" maxlength="13" class="w-full bg-white border border-black/20 rounded-lg px-2.5 py-1.5 text-xs sm:text-sm font-semibold outline-none focus:ring-2 focus:ring-green-600">
                    </div>
                    <div>
                        <label class="text-[11px] sm:text-xs font-bold text-[#2A1001] block mb-0.5">Maya Reference Code:</label>
                        <input type="text" id="maya-ref" value="${refNumber}" readonly class="w-full bg-gray-100 border border-black/15 rounded-lg px-2.5 py-1.5 text-xs sm:text-sm font-semibold outline-none text-gray-500 cursor-not-allowed">
                    </div>
                </div>
            </div>
        `;
        restrictToDigits(document.getElementById('maya-mobile'), 11);
    } else if (channel === 'gotyme') {
        box.innerHTML = `
            <div class="flex flex-col gap-2">
                <div class="bg-purple-50 p-2 rounded-xl border border-purple-700/30 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-1">
                    <div>
                        <p class="text-xs font-bold text-purple-900">GoTyme Digital Bank Transfer</p>
                        <p class="text-[11px] text-purple-700">Account No: <strong>0123-4567-8910</strong> (Dental Clinic)</p>
                    </div>
                    <span class="bg-purple-700 text-white font-black text-[9px] px-2 py-0.5 rounded-full">GoTyme Bank</span>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                        <label class="text-[11px] sm:text-xs font-bold text-[#2A1001] block mb-0.5">Account Holder Name: <span class="text-red-500">*</span></label>
                        <input type="text" id="gotyme-name" placeholder="Juan Dela Cruz" class="w-full bg-white border border-black/20 rounded-lg px-2.5 py-1.5 text-xs sm:text-sm font-semibold outline-none focus:ring-2 focus:ring-purple-700">
                    </div>
                    <div>
                        <label class="text-[11px] sm:text-xs font-bold text-[#2A1001] block mb-0.5">Card Last 4 Digits: <span class="text-red-500">*</span></label>
                        <input type="text" id="gotyme-account" placeholder="XXXX" maxlength="4" class="w-full bg-white border border-black/20 rounded-lg px-2.5 py-1.5 text-xs sm:text-sm font-semibold outline-none focus:ring-2 focus:ring-purple-700">
                    </div>
                </div>
            </div>
        `;
        restrictToNameChars(document.getElementById('gotyme-name'));
        restrictToDigits(document.getElementById('gotyme-account'), 4);
    } else if (channel === 'card') {
        box.innerHTML = `
            <div class="flex flex-col gap-2">
                <div class="flex flex-col sm:flex-row sm:items-center justify-between bg-blue-50/60 p-1.5 rounded-xl border border-blue-200 text-[11px] sm:text-xs text-blue-900 font-semibold gap-1">
                    <span><i class="fa-solid fa-lock text-green-600 mr-1"></i> 256-bit Encrypted Card Payment</span>
                    <span class="flex gap-1 text-sm text-gray-700">
                        <i class="fa-brands fa-cc-visa text-blue-700"></i>
                        <i class="fa-brands fa-cc-mastercard text-orange-600"></i>
                        <i class="fa-regular fa-credit-card text-emerald-600"></i>
                    </span>
                </div>
                <div>
                    <label class="text-[11px] sm:text-xs font-bold text-[#2A1001] block mb-0.5">Cardholder Full Name: <span class="text-red-500">*</span></label>
                    <input type="text" id="card-name" placeholder="JUAN DELA CRUZ" class="w-full uppercase bg-white border border-black/20 rounded-lg px-2.5 py-1.5 text-xs sm:text-sm font-semibold outline-none focus:ring-2 focus:ring-[#667733]">
                </div>
                <div>
                    <label class="text-[11px] sm:text-xs font-bold text-[#2A1001] block mb-0.5">Card Number: <span class="text-red-500">*</span></label>
                    <input type="text" id="card-number" placeholder="4111 2222 3333 4444" maxlength="19" class="w-full bg-white border border-black/20 rounded-lg px-2.5 py-1.5 text-xs sm:text-sm font-semibold outline-none focus:ring-2 focus:ring-[#667733]">
                </div>
                <div class="grid grid-cols-2 gap-2">
                    <div>
                        <label class="text-[11px] sm:text-xs font-bold text-[#2A1001] block mb-0.5">Expiry (MM/YY): <span class="text-red-500">*</span></label>
                        <input type="text" id="card-expiry" placeholder="12/28" maxlength="5" class="w-full bg-white border border-black/20 rounded-lg px-2.5 py-1.5 text-xs sm:text-sm font-semibold outline-none focus:ring-2 focus:ring-[#667733]">
                    </div>
                    <div>
                        <label class="text-[11px] sm:text-xs font-bold text-[#2A1001] block mb-0.5">CVV / CVC: <span class="text-red-500">*</span></label>
                        <input type="password" id="card-cvv" placeholder="•••" maxlength="4" class="w-full bg-white border border-black/20 rounded-lg px-2.5 py-1.5 text-xs sm:text-sm font-semibold outline-none focus:ring-2 focus:ring-[#667733]">
                    </div>
                </div>
            </div>
        `;
        restrictToNameChars(document.getElementById('card-name'));
        restrictToDigitsAndSpaces(document.getElementById('card-number'), 19);
        restrictToExpiryFormat(document.getElementById('card-expiry'));
        restrictToDigits(document.getElementById('card-cvv'), 4);
    } else if (channel === 'paypal') {
        box.innerHTML = `
            <div class="flex flex-col gap-2">
                <div class="bg-blue-50 p-2 rounded-xl border border-blue-300 text-[11px] sm:text-xs text-[#003087] font-semibold flex items-center gap-2">
                    <i class="fa-brands fa-paypal text-base"></i> You will complete authorized PayPal checkout.
                </div>
                <div>
                    <label class="text-[11px] sm:text-xs font-bold text-[#2A1001] block mb-0.5">PayPal Email Address: <span class="text-red-500">*</span></label>
                    <input type="email" id="paypal-email" placeholder="you@example.com" class="w-full bg-white border border-black/20 rounded-lg px-2.5 py-1.5 text-xs sm:text-sm font-semibold outline-none focus:ring-2 focus:ring-[#003087]">
                </div>
            </div>
        `;
    }
}

// ── 6. Modal & Booking Workflow ─────────────────────────────────────────────
function initBookingForm() {
    const bookingForm           = document.getElementById('booking-form');
    const receiptModal          = document.getElementById('receipt-modal');
    const closeModalBtn         = document.getElementById('close-modal');
    const receiptContent        = document.getElementById('receipt-content');
    const payOnlineBtn          = document.getElementById('pay-online-btn');
    const payCashBtn            = document.getElementById('pay-cash-btn');
    const onlinePaymentModal    = document.getElementById('online-payment-modal');
    const closeOnlinePaymentBtn = document.getElementById('close-online-payment-btn');
    const submitOnlineBookingBtn = document.getElementById('submitOnlineBookingBtn');

    if (!bookingForm) return;

    bookingForm.addEventListener('submit', (e) => {
        e.preventDefault();

        if (!selectedDoctorId) {
            showValidationModal('Please select an attending dentist before continuing.', document.getElementById('doctorSelect'));
            return;
        }
        if (selectedServices.length === 0) {
            showValidationModal('Please select at least one dental treatment.');
            return;
        }
        if (!selectedDateValue) {
            showValidationModal('Please pick an appointment date on the calendar.');
            return;
        }
        if (!selectedStartTime) {
            showValidationModal('Please select an available starting time slot.');
            return;
        }

        const noteVal = sanitizeInput(document.getElementById('PNote')?.value, 250) || 'None';
        const docObj  = availableDoctors.find(d => d.doctor_id == selectedDoctorId);
        const doctorName = docObj ? docObj.name : 'Attending Dentist';
        const totalAmount = selectedServices.reduce((sum, s) => sum + s.price, 0);
        const totalMinutes = selectedServices.reduce((sum, s) => sum + (s.duration_minutes || 30), 0);

        const servicesListHtml = selectedServices.map(s => `
            <div class="flex justify-between items-center py-1 text-xs sm:text-sm border-b border-black/10">
                <div>
                    <span class="font-bold text-[#2A1001]">${escapeHtml(s.label)}</span>
                    <span class="text-[10px] text-gray-500 ml-1">(${s.duration_minutes || 30}m)</span>
                </div>
                <span class="font-black text-[#2A1001]">₱${s.price.toLocaleString()}</span>
            </div>
        `).join('');

        receiptContent.innerHTML = `
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5 sm:gap-2 pb-2 border-b border-black/15 text-xs sm:text-sm">
                <p><span class="font-bold text-[#2A1001]/60">Date:</span> <strong>${escapeHtml(selectedDateValue)}</strong></p>
                <p><span class="font-bold text-[#2A1001]/60">Schedule:</span> <strong>${format12Hour(selectedStartTime)} – ${format12Hour(selectedEndTime)}</strong></p>
                <p><span class="font-bold text-[#2A1001]/60">Est. Duration:</span> <strong>${formatDuration(totalMinutes)}</strong></p>
                <p><span class="font-bold text-[#2A1001]/60">Attending Dentist:</span> <strong>${escapeHtml(doctorName)}</strong></p>
            </div>

            <div class="flex flex-col gap-1 my-1">
                <p class="font-extrabold text-xs uppercase text-[#2A1001]/70">Selected Treatments (${selectedServices.length}):</p>
                ${servicesListHtml}
            </div>

            <div class="flex justify-between items-center pt-2 border-t border-black/20 text-sm sm:text-base font-black text-[#667733]">
                <span>Total Amount Due:</span>
                <span>₱${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
            </div>

            <div class="bg-white/80 p-2 sm:p-2.5 rounded-xl border border-black/10 text-xs mt-1">
                <span class="font-bold">Patient Note:</span>
                <p class="italic text-[#2A1001]/80 mt-0.5">${escapeHtml(noteVal)}</p>
            </div>
        `;

        receiptModal.classList.remove('hidden');
    });

    if (closeModalBtn) {
        closeModalBtn.addEventListener('click', () => {
            receiptModal.classList.add('hidden');
        });
    }

    if (payOnlineBtn) {
        payOnlineBtn.addEventListener('click', () => {
            receiptModal.classList.add('hidden');
            renderChannelContent(currentPaymentChannel);
            onlinePaymentModal.classList.remove('hidden');
        });
    }

    if (closeOnlinePaymentBtn) {
        closeOnlinePaymentBtn.addEventListener('click', () => {
            onlinePaymentModal.classList.add('hidden');
            receiptModal.classList.remove('hidden');
        });
    }

    if (payCashBtn) {
        payCashBtn.addEventListener('click', () => {
            const cashModal = document.getElementById('cash-confirm-modal');
            const cancelBtn = document.getElementById('cash-confirm-cancel');
            const okBtn = document.getElementById('cash-confirm-ok');
            if (!cashModal || !cancelBtn || !okBtn) {
                if (confirm("Confirm booking this appointment with In-Clinic Cash payment?")) {
                    receiptModal.classList.add('hidden');
                    submitBookingToDatabase('cash', null, null);
                }
                return;
            }
            cashModal.classList.remove('hidden');
            cancelBtn.onclick = () => cashModal.classList.add('hidden');
            okBtn.onclick = () => {
                cashModal.classList.add('hidden');
                receiptModal.classList.add('hidden');
                submitBookingToDatabase('cash', null, null);
            };
        });
    }

    if (submitOnlineBookingBtn) {
        submitOnlineBookingBtn.addEventListener('click', () => {
            let paymentRef = '';

            if (currentPaymentChannel === 'gcash') {
                const mobField = document.getElementById('gcash-mobile');
                const mob = sanitizeInput(mobField?.value, 11);
                if (!mob) { showValidationModal('Please input your GCash mobile number.', mobField); return; }
                if (!isValidPHMobile(mob)) { showValidationModal('Please enter a valid PH mobile number (e.g. 09171234567).', mobField); return; }
                paymentRef = sanitizeInput(document.getElementById('gcash-ref')?.value, 30) || 'GCASH-' + Date.now();

            } else if (currentPaymentChannel === 'maya') {
                const mobField = document.getElementById('maya-mobile');
                const mob = sanitizeInput(mobField?.value, 11);
                if (!mob) { showValidationModal('Please input your Maya mobile number.', mobField); return; }
                if (!isValidPHMobile(mob)) { showValidationModal('Please enter a valid PH mobile number (e.g. 09171234567).', mobField); return; }
                paymentRef = sanitizeInput(document.getElementById('maya-ref')?.value, 30) || 'MAYA-' + Date.now();

            } else if (currentPaymentChannel === 'gotyme') {
                const nameField = document.getElementById('gotyme-name');
                const accField = document.getElementById('gotyme-account');
                const name = sanitizeInput(nameField?.value, 60);
                const acc = sanitizeInput(accField?.value, 4);
                if (!name) { showValidationModal('Please input your GoTyme account name.', nameField); return; }
                if (!isValidNameField(name)) { showValidationModal('Account name should only contain letters, spaces, and basic punctuation.', nameField); return; }
                if (!acc) { showValidationModal('Please input the last 4 digits of your card.', accField); return; }
                if (!isValidCardLast4(acc)) { showValidationModal('Please enter exactly 4 digits.', accField); return; }
                paymentRef = 'GOTYME-' + Date.now();

            } else if (currentPaymentChannel === 'card') {
                const nameField = document.getElementById('card-name');
                const numField = document.getElementById('card-number');
                const expField = document.getElementById('card-expiry');
                const cvvField = document.getElementById('card-cvv');
                const name = sanitizeInput(nameField?.value, 60);
                const num = sanitizeInput(numField?.value, 19);
                const exp = sanitizeInput(expField?.value, 5);
                const cvv = sanitizeInput(cvvField?.value, 4);

                if (!name || !num || !exp || !cvv) { showValidationModal('Please fill in complete Card details.', numField); return; }
                if (!isValidNameField(name)) { showValidationModal('Cardholder name should only contain letters and spaces.', nameField); return; }
                if (!isValidCardNumber(num)) { showValidationModal('Please enter a valid card number.', numField); return; }
                if (!isValidExpiry(exp)) { showValidationModal('Please enter a valid, non-expired date (MM/YY).', expField); return; }
                if (!isValidCVV(cvv)) { showValidationModal('Please enter a valid 3 or 4-digit CVV.', cvvField); return; }

                paymentRef = 'CARD-' + num.replace(/\s/g, '').slice(-4) + '-' + Date.now();

            } else if (currentPaymentChannel === 'paypal') {
                const emailField = document.getElementById('paypal-email');
                const email = sanitizeInput(emailField?.value, 100);
                if (!email) { showValidationModal('Please enter your PayPal email address.', emailField); return; }
                if (!isValidEmail(email)) { showValidationModal('Please enter a valid email address.', emailField); return; }
                paymentRef = 'PAYPAL-' + email;
            }

            submitOnlineBookingBtn.disabled = true;
            submitOnlineBookingBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> Processing Online Payment...';

            setTimeout(() => {
                onlinePaymentModal.classList.add('hidden');
                submitBookingToDatabase('online', currentPaymentChannel, paymentRef);
            }, 800);
        });
    }
}

// ── Validation Input Helpers ────────────────────────────────────────────────
function restrictToDigits(input, maxLen) {
    if (!input) return;
    input.addEventListener('input', () => {
        let digitsOnly = input.value.replace(/\D/g, '');
        if (maxLen) digitsOnly = digitsOnly.slice(0, maxLen);
        input.value = digitsOnly;
    });
}

function restrictToDigitsAndSpaces(input, maxLen) {
    if (!input) return;
    input.addEventListener('input', () => {
        let filtered = input.value.replace(/[^\d ]/g, '');
        if (maxLen) filtered = filtered.slice(0, maxLen);
        input.value = filtered;
    });
}

function restrictToExpiryFormat(input) {
    if (!input) return;
    input.addEventListener('input', () => {
        let v = input.value.replace(/[^\d/]/g, '');
        if (v.length === 2 && !v.includes('/') && input.dataset.lastLen < v.length) {
            v = v + '/';
        }
        input.dataset.lastLen = v.length;
        input.value = v.slice(0, 5);
    });
}

function restrictToNameChars(input) {
    if (!input) return;
    const clean = () => {
        input.value = input.value.replace(/[^a-zA-ZñÑ.'\- ]/g, '');
    };
    input.addEventListener('input', clean);
    input.addEventListener('paste', () => setTimeout(clean, 0));
    input.addEventListener('blur', clean);
}

function showValidationModal(message, focusTarget = null) {
    const modal = document.getElementById('validation-modal');
    const text = document.getElementById('validation-modal-text');
    const okBtn = document.getElementById('validation-modal-ok');

    if (!modal || !text || !okBtn) {
        alert(message);
        return;
    }

    text.textContent = message;
    modal.classList.remove('hidden');

    const closeModal = () => {
        modal.classList.add('hidden');
        if (focusTarget) focusTarget.focus();
    };

    okBtn.onclick = closeModal;
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
}

function showSuccessModal({ date, time, doctorName, servicesLabel, amount }) {
    const modal = document.getElementById('success-modal');
    const details = document.getElementById('success-modal-details');
    const okBtn = document.getElementById('success-modal-ok');

    if (!modal || !details || !okBtn) {
        alert('Booking confirmed!');
        window.location.href = 'History.html';
        return;
    }

    details.innerHTML = `
        <div class="flex justify-between"><span class="font-bold text-[#2A1001]/60">Date:</span><span class="font-semibold">${escapeHtml(date || '')}</span></div>
        <div class="flex justify-between"><span class="font-bold text-[#2A1001]/60">Time:</span><span class="font-semibold">${escapeHtml(time || '')}</span></div>
        <div class="flex justify-between"><span class="font-bold text-[#2A1001]/60">Dentist:</span><span class="font-semibold">${escapeHtml(doctorName || '')}</span></div>
        <div class="flex justify-between"><span class="font-bold text-[#2A1001]/60">Services:</span><span class="font-semibold text-right">${escapeHtml(servicesLabel || '')}</span></div>
        <div class="flex justify-between border-t border-black/10 pt-1.5 mt-1"><span class="font-bold text-[#2A1001]/60">Amount Paid:</span><span class="font-black text-[#667733]">₱${Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span></div>
    `;
    modal.classList.remove('hidden');

    okBtn.onclick = () => {
        modal.classList.add('hidden');
        window.location.href = 'History.html';
    };
}


// ── 7. Submit Appointment to Backend// API ────────────────────────────────────
async function submitBookingToDatabase(method, channel = null, reference = null) {
    const token = localStorage.getItem('userToken');

    const totalMinutes = selectedServices.reduce((sum, s) => sum + (s.duration_minutes || 30), 0);

    const payload = {
        appointment_date: selectedDateValue,
        time_slot: selectedStartTime,
        end_time_slot: selectedEndTime,
        estimated_duration_minutes: totalMinutes,
        doctor_id: selectedDoctorId || null,
        service_id: selectedServices[0].service_id,
        service_ids: selectedServices.map(s => s.service_id),
        patient_note: sanitizeInput(document.getElementById('PNote')?.value, 250),
        payment_method: method,
        payment_channel: channel || (method === 'cash' ? 'cash' : 'online'),
        payment_reference: reference || null
    };

    try {
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const response = await fetch(`${API_BASE_URL}/api/appointments`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
        });

        const result = await response.json();
        if (!response.ok) throw new Error(result.message || 'Failed to complete booking.');

        const docObj = availableDoctors.find(d => d.doctor_id == selectedDoctorId);
        const totalAmount = selectedServices.reduce((sum, s) => sum + s.price, 0);

        showSuccessModal({
            date: selectedDateValue,
            time: `${format12Hour(selectedStartTime)} – ${format12Hour(selectedEndTime)}`,
            doctorName: docObj ? docObj.name : 'Attending Dentist',
            servicesLabel: selectedServices.map(s => s.label).join(', '),
            amount: totalAmount
        });

    } catch (error) {
        console.error('Booking Submission Error:', error);
        showValidationModal('Booking Error: ' + error.message);
        const submitOnlineBtn = document.getElementById('submitOnlineBookingBtn');
        if (submitOnlineBtn) {
            submitOnlineBtn.disabled = false;
            submitOnlineBtn.innerHTML = '<i class="fa-solid fa-check-circle"></i> Confirm &amp; Finalize Booking';
        }
    }
}