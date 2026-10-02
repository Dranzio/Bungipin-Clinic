// ── BOOKING CONTROLLER (Clean 30-Min Intervals & Strict Specialization) ───────
// [PAYMONGO PATCH] OVERVIEW — Online payment now goes through PayMongo's hosted
// checkout (the server returns `checkout_url` and we redirect to it). The old
// fake payment UI (typed-in GCash/Maya/GoTyme/PayPal/card forms + setTimeout)
// was removed. Everything else (services, doctors, calendar, slots, cash
// booking) is unchanged. Search this file for "[PAYMONGO PATCH]" to see each edit.
const API_BASE_URL = window.BACKEND_API_BASE_URL || '';

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

function sanitizeInput(str, maxLen = 100) {
    return String(str ?? '').trim().replace(/[<>]/g, '').slice(0, maxLen);
}

// [PAYMONGO PATCH] REMOVED here: isValidPHMobile, isValidEmail, isValidCardNumber,
// isValidExpiry, isValidCVV, isValidCardLast4, isValidNameField. They only served
// the removed fake payment forms (card/e-wallet details are now entered on
// PayMongo's page, never on ours).
// ── State Management ────────────────────────────────────────────────────────
let availableServices = [];
let availableDoctors  = [];
let selectedServices  = [];
let selectedDoctorId  = null;
let selectedDateValue = '';
let selectedStartTime = '';
let selectedEndTime   = '';
// [PAYMONGO PATCH] REMOVED: `let currentPaymentChannel = 'gcash';` (channel is now picked on PayMongo's page).

function getEstimatedDuration(service) {
    if (service.duration_minutes) return Number(service.duration_minutes);
    const lbl = String(service.label || '').toLowerCase();
    if (lbl.includes('clean') || lbl.includes('prophylaxis')) return 45;
    if (lbl.includes('whiten')) return 60;
    if (lbl.includes('root') || lbl.includes('canal')) return 90;
    if (lbl.includes('extract') || lbl.includes('surgery')) return 60;
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

function doctorCanPerformService(doctorSpecialization, serviceRequiredSpec) {
    if (!serviceRequiredSpec) return true;
    const req = serviceRequiredSpec.toLowerCase().trim();
    const doc = (doctorSpecialization || 'General Dentist').toLowerCase().trim();

    if (req.includes('general')) {
        return doc.includes('general');
    }
    return doc.includes(req) || req.includes(doc);
}

document.addEventListener('DOMContentLoaded', () => {
    initCalendar();
    initDoctorSelection();
    loadServices();
    loadDoctors();
    initBookingForm();
    // [PAYMONGO PATCH] REMOVED: initPaymentChannels(); (the fake channel tabs no longer exist)
});

// ── 1. Load Services ────────────────────────────────────────────────────────
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
            renderServiceCards();
        } else {
            throw new Error();
        }
    } catch {
        availableServices = [
            { service_id: 1, label: 'Dental Checkup & Consultation', price: 500, duration_minutes: 30, required_specialization: 'General Dentist', icon: '../assets/Checkup.png' },
            { service_id: 2, label: 'Oral Prophylaxis (Cleaning)', price: 1500, duration_minutes: 45, required_specialization: 'General Dentist', icon: '../assets/cleaning.png' },
            { service_id: 3, label: 'Tooth Restoration (Pasta)', price: 1200, duration_minutes: 30, required_specialization: 'General Dentist', icon: '../assets/pasta.png' },
            { service_id: 4, label: 'Laser Teeth Whitening', price: 4500, duration_minutes: 60, required_specialization: 'General Dentist', icon: '../assets/whitening.png' },
            { service_id: 5, label: 'Braces Installation / Adjustment', price: 3500, duration_minutes: 60, required_specialization: 'Orthodontist', icon: '../assets/logo.png' },
            { service_id: 6, label: 'Root Canal Treatment', price: 6500, duration_minutes: 90, required_specialization: 'Endodontist', icon: '../assets/logo.png' },
            { service_id: 7, label: 'Impacted Wisdom Tooth Surgery', price: 5000, duration_minutes: 60, required_specialization: 'Oral Surgeon', icon: '../assets/logo.png' }
        ];
        renderServiceCards();
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

// ── 2. Render Services (DOCTOR-FIRST FILTERING) ─────────────────────────────
function renderServiceCards() {
    const serviceGrid = document.getElementById('service-grid');
    if (!serviceGrid) return;
    serviceGrid.innerHTML = '';

    const selectedDoctor = availableDoctors.find(d => d.doctor_id == selectedDoctorId);
    const doctorSpec = selectedDoctor ? selectedDoctor.specialization : null;

    availableServices.forEach(service => {
        const isSelected = selectedServices.some(s => s.service_id == service.service_id);
        const card = document.createElement('div');
        const duration = getEstimatedDuration(service);
        const reqSpec = service.required_specialization || 'General Dentist';
        const isCompatible = !doctorSpec || doctorCanPerformService(doctorSpec, reqSpec);

        card.dataset.serviceId = service.service_id;

        const imgSrc = (service.icon && (/^(\/|https?:\/\/|\.\.\/assets\/)/.test(service.icon)))
            ? service.icon
            : fallbackIcon(service.label);

        if (!isCompatible && selectedDoctor) {
            // 🔴 RED BANNER — INCOMPATIBLE WITH CURRENT DOCTOR
            card.className = `flex flex-col w-full max-w-[240px] h-[270px] justify-between items-center text-center rounded-2xl border-2 border-dashed border-red-400 bg-red-50/50 transition-all duration-200 cursor-not-allowed p-4 pt-7 relative shadow-sm opacity-70 select-none overflow-hidden`;

            card.innerHTML = `
                <div class="absolute -top-0.5 inset-x-0 bg-red-600 text-white text-[9px] font-black uppercase tracking-wider py-0.5 text-center shadow-sm">
                    ⚠️ Requires: ${escapeHtml(reqSpec)}
                </div>

                <div class="absolute top-3 left-2.5 bg-amber-100 border border-amber-500/30 text-amber-900 text-[10px] font-extrabold px-2 py-0.5 rounded-full flex items-center gap-1">
                    <i class="fa-regular fa-clock text-[9px]"></i> ${duration}m
                </div>

                <h3 class="font-extrabold text-sm sm:text-base break-words w-full text-gray-600 line-clamp-2 px-2 mt-4">
                    ${escapeHtml(service.label)}
                </h3>

                <img src="${imgSrc}" class="w-14 h-14 object-contain my-1 grayscale opacity-60" alt="${escapeHtml(service.label)}" onerror="this.src='../assets/logowithtitle.png'">

                <div class="w-full pt-1.5 border-t border-red-200 flex flex-col items-center">
                    <span class="text-[10px] font-bold text-red-600 leading-tight">Unavailable with ${escapeHtml(doctorSpec)}</span>
                    <span class="font-black text-xs text-gray-500 mt-0.5">₱${Number(service.price).toLocaleString()}</span>
                </div>
            `;

            // ⚠️ BLOCKS SELECTION
            card.addEventListener('click', () => {
                showValidationModal(`Cannot add "${service.label}".\n\nDr. ${selectedDoctor.name} is a ${doctorSpec}. This procedure requires a ${reqSpec}.\n\nPlease select a ${reqSpec} from the dentist dropdown above to book this service.`);
            });

        } else {
            // ✅ COMPATIBLE / ACTIVE CARD
            card.className = `flex flex-col w-full max-w-[240px] h-[270px] justify-between items-center text-center rounded-2xl border-2 transition-all duration-200 cursor-pointer p-4 pt-7 relative shadow-sm hover:scale-[1.02] overflow-hidden ${
                isSelected 
                    ? 'bg-[#D7E3A5] border-[#667733] ring-2 ring-[#667733]' 
                    : 'bg-white border-black hover:bg-[#F7F5EE]'
            }`;

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
        }

        serviceGrid.appendChild(card);
    });

    updateLiveCalculations();
}

// ── 3. Toggle Service Selection (SERVICE-FIRST FILTERING) ───────────────────
function toggleServiceSelection(service) {
    const index = selectedServices.findIndex(s => s.service_id == service.service_id);
    const duration = getEstimatedDuration(service);
    const reqSpec = service.required_specialization || 'General Dentist';

    if (index > -1) {
        selectedServices.splice(index, 1);
    } else {
        // Block if currently selected doctor cannot perform this service
        if (selectedDoctorId) {
            const currentDoc = availableDoctors.find(d => d.doctor_id == selectedDoctorId);
            if (currentDoc && !doctorCanPerformService(currentDoc.specialization, reqSpec)) {
                showValidationModal(`Cannot add "${service.label}". Dr. ${currentDoc.name} is a ${currentDoc.specialization} and cannot perform this treatment.`);
                return;
            }
        }

        selectedServices.push({
            service_id: service.service_id,
            label: service.label,
            price: Number(service.price || 0),
            duration_minutes: duration,
            required_specialization: reqSpec
        });
    }

    // 💡 Filters Doctor Dropdown according to selected services
    populateDoctorDropdown();
    renderServiceCards();

    if (selectedDoctorId && selectedDateValue) {
        fetchAvailableSlotsForDoctor(selectedDoctorId, selectedDateValue);
    }
}

function updateLiveCalculations() {
    const totalAmount = selectedServices.reduce((sum, s) => sum + s.price, 0);
    const totalMinutes = selectedServices.reduce((sum, s) => sum + (s.duration_minutes || 30), 0);

    const displayTotal = document.getElementById('liveTotalDisplay');
    const displayDuration = document.getElementById('liveDurationDisplay');
    // [PAYMONGO PATCH] REMOVED: `onlineAmountText` (#onlinePayAmountText lived in the deleted online-payment modal).

    if (displayTotal) displayTotal.textContent = `₱${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    if (displayDuration) displayDuration.textContent = formatDuration(totalMinutes);

    const slotInfoBadge = document.getElementById('slotInfoBadge');
    if (slotInfoBadge) {
        slotInfoBadge.textContent = totalMinutes > 0 ? `Est. Session Window: ${formatDuration(totalMinutes)}` : '';
    }
}

// ── 4. Load & Populate Doctor Dropdown (SERVICE-FIRST FILTER) ───────────────
async function loadDoctors() {
    try {
        const token = localStorage.getItem('userToken');
        const response = await fetch(`${API_BASE_URL}/api/doctors`, {
            headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });

        if (response.ok) {
            availableDoctors = await response.json();
            populateDoctorDropdown();
        } else {
            throw new Error();
        }
    } catch {
        availableDoctors = [
            { doctor_id: 1, name: 'Dr. Ramon Cruz', specialization: 'General Dentist', position: 'Dentist' },
            { doctor_id: 2, name: 'Dr. Liza Tan', specialization: 'Orthodontist', position: 'Dentist' },
            { doctor_id: 3, name: 'Dr. Maria Gomez', specialization: 'Endodontist', position: 'Dentist' }
        ];
        populateDoctorDropdown();
    }
}

function populateDoctorDropdown() {
    const doctorSelect = document.getElementById('doctorSelect');
    if (!doctorSelect) return;

    doctorSelect.innerHTML = '<option value="" disabled selected class="text-gray-400">-- Select Your Attending Dentist --</option>';

    const requiredSpecs = [...new Set(selectedServices.map(s => s.required_specialization || 'General Dentist'))];

    availableDoctors.forEach(doc => {
        const docSpec = doc.specialization || 'General Dentist';
        const isQualified = requiredSpecs.length === 0 || requiredSpecs.every(req => doctorCanPerformService(docSpec, req));

        const opt = document.createElement('option');
        opt.value = doc.doctor_id;

        if (isQualified) {
            opt.textContent = `${doc.name} (${docSpec})${requiredSpecs.length > 0 ? ' — Qualified Specialist' : ''}`;
            opt.className = 'text-[#2A1001] font-bold';
            doctorSelect.appendChild(opt);
        } else {
            opt.textContent = `${doc.name} (${docSpec}) — Incompatible with selected service`;
            opt.disabled = true;
            opt.className = 'text-gray-400 bg-gray-100 italic';
            doctorSelect.appendChild(opt);
        }
    });

    if (selectedDoctorId) {
        const currentDoc = availableDoctors.find(d => d.doctor_id == selectedDoctorId);
        const isCurrentStillQualified = currentDoc && (requiredSpecs.length === 0 || requiredSpecs.every(req => doctorCanPerformService(currentDoc.specialization, req)));

        if (isCurrentStillQualified) {
            doctorSelect.value = selectedDoctorId;
            doctorSelect.classList.remove('text-gray-400');
            doctorSelect.classList.add('text-[#2A1001]');
        } else {
            selectedDoctorId = null;
            doctorSelect.selectedIndex = 0;
            document.getElementById('selected-doctor-id').value = '';
            doctorSelect.classList.add('text-gray-400');
            doctorSelect.classList.remove('text-[#2A1001]');
        }
    }
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

        const currentDoc = availableDoctors.find(d => d.doctor_id == selectedDoctorId);

        // 🧹 Clean up incompatible services when switching doctors
        if (currentDoc) {
            const beforeCount = selectedServices.length;
            selectedServices = selectedServices.filter(s => 
                doctorCanPerformService(currentDoc.specialization, s.required_specialization)
            );
            if (selectedServices.length < beforeCount) {
                showValidationModal(`Some services were deselected because Dr. ${currentDoc.name} specializes in ${currentDoc.specialization}.`);
            }
        }

        renderServiceCards();

        if (selectedDateValue && selectedDoctorId) {
            fetchAvailableSlotsForDoctor(selectedDoctorId, selectedDateValue);
        }
    });
}

// ── 5. Dynamic Time Slots Fetcher (CLEAN 30-MIN INTERVALS PRESERVED) ─────────
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

// ── Clean 30-Min Dynamic Intervals Render ───────────────────────────────────
function renderDynamicSlots(container, slots, durationMinutes) {
    container.innerHTML = '';

    const amSlots = slots.filter(s => parseInt(s.time_slot.split(':')[0], 10) < 12);
    const pmSlots = slots.filter(s => parseInt(s.time_slot.split(':')[0], 10) >= 12);
    const durationLabel = formatDuration(durationMinutes);

    container.innerHTML = `
        <div class="flex flex-col sm:flex-row gap-4 justify-between w-full">
            <div class="flex-1 flex flex-col gap-2.5">
                <h3 class="font-extrabold text-xs text-[#2A1001] uppercase tracking-wider flex items-center gap-1.5 pb-1 border-b border-[#2A1001]/10">
                    <i class="fa-solid fa-sun text-amber-500"></i> Morning (AM)
                </h3>
                <div class="flex flex-col gap-2" id="amSlotsList">
                    ${amSlots.length === 0 ? '<p class="text-xs text-gray-400 italic py-2">No morning slots available.</p>' : ''}
                </div>
            </div>

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

        if (slot.is_available) {
            btn.className = `time-slot-btn flex flex-col w-full py-2.5 px-3 rounded-2xl border-2 items-center justify-center text-center font-bold text-xs transition active:scale-95 cursor-pointer shadow-sm ${
                isSelected
                    ? 'bg-[#667733] border-[#667733] text-white ring-2 ring-offset-2 ring-[#667733]'
                    : 'bg-white border-black text-[#2A1001] hover:bg-[#F0F5DE]'
            }`;
            btn.innerHTML = `
                <span class="text-xs sm:text-sm font-extrabold flex items-center gap-1.5">
                    ${isSelected ? '<i class="fa-solid fa-circle-check"></i>' : ''}
                    ${format12Hour(slot.time_slot)} – ${format12Hour(slot.end_time_slot)}
                </span>
                <span class="text-[10px] font-semibold mt-0.5 ${isSelected ? 'text-white/80' : 'text-amber-800'}">
                    ⏱️ Session: ${durationLabel}
                </span>
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

// ── 6. Calendar Logic ───────────────────────────────────────────────────────
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

// [PAYMONGO PATCH] REMOVED the whole "7. Philippine Payment Channels" section:
//   initPaymentChannels() and renderChannelContent() — fake GCash / Maya / GoTyme /
//   PayPal / Card forms with fake QR codes and made-up merchant numbers. They never
//   charged anyone. Replaced by PayMongo hosted checkout (see "9. Submit Appointment").
// ── 8. Booking Form & Summary Modals ────────────────────────────────────────
function initBookingForm() {
    const bookingForm           = document.getElementById('booking-form');
    const receiptModal          = document.getElementById('receipt-modal');
    const closeModalBtn         = document.getElementById('close-modal');
    const receiptContent        = document.getElementById('receipt-content');
    const payOnlineBtn          = document.getElementById('pay-online-btn');
    const payCashBtn            = document.getElementById('pay-cash-btn');
    // [PAYMONGO PATCH] REMOVED consts: onlinePaymentModal, closeOnlinePaymentBtn,
    // submitOnlineBookingBtn (their HTML was deleted from Booking.html).
    // Also: cash calls were shortened from submitBookingToDatabase('cash', null, null) to ('cash').

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

    if (closeModalBtn) closeModalBtn.addEventListener('click', () => receiptModal.classList.add('hidden'));

    // [PAYMONGO PATCH] REPLACED the old "Pay Online" handler (it opened the fake modal).
    // Online payment: create the held booking, then send the patient to
    // PayMongo's hosted checkout. NO card / wallet details are collected here.
    if (payOnlineBtn) {
        payOnlineBtn.addEventListener('click', () => {
            if (payOnlineBtn.disabled) return;
            payOnlineBtn.disabled = true;
            payOnlineBtn.dataset.originalHtml = payOnlineBtn.innerHTML;
            payOnlineBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Opening secure checkout...';
            submitBookingToDatabase('online');
        });

        // Browser Back from PayMongo can restore this page from cache with the
        // button still disabled — reset it.
        window.addEventListener('pageshow', (e) => { if (e.persisted) resetPayOnlineBtn(); });
    }

    if (payCashBtn) {
        payCashBtn.addEventListener('click', () => {
            const cashModal = document.getElementById('cash-confirm-modal');
            const cancelBtn = document.getElementById('cash-confirm-cancel');
            const okBtn = document.getElementById('cash-confirm-ok');
            if (!cashModal || !cancelBtn || !okBtn) {
                if (confirm("Confirm booking this appointment with In-Clinic Cash payment?")) {
                    receiptModal.classList.add('hidden');
                    submitBookingToDatabase('cash');
                }
                return;
            }
            cashModal.classList.remove('hidden');
            cancelBtn.onclick = () => cashModal.classList.add('hidden');
            okBtn.onclick = () => {
                cashModal.classList.add('hidden');
                receiptModal.classList.add('hidden');
                submitBookingToDatabase('cash');
            };
        });
    }

    // [PAYMONGO PATCH] REMOVED from initBookingForm: the close-online-payment click
    // handler and the entire submitOnlineBookingBtn handler (per-channel validation
    // + `setTimeout(...)` fake payment + submitBookingToDatabase('online', channel, ref)).
}

// [PAYMONGO PATCH] REMOVED the "Validation Input Helpers" that only the fake forms used:
// restrictToDigits, restrictToDigitsAndSpaces, restrictToExpiryFormat, restrictToNameChars.
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

// ── 9. Submit Appointment ───────────────────────────────────────────────────
// [PAYMONGO PATCH] REWRITTEN: submitBookingToDatabase(method) now takes only 'cash' or
// 'online'. It no longer sends payment_channel / payment_reference (the server and
// PayMongo decide those). For 'online' it redirects to the returned checkout_url;
// for 'cash' it shows the success modal as before. Also added resetPayOnlineBtn()
// and 409 handling (slot taken -> refresh the slot list).
function resetPayOnlineBtn() {
    const btn = document.getElementById('pay-online-btn');
    if (!btn) return;
    btn.disabled = false;
    if (btn.dataset.originalHtml) btn.innerHTML = btn.dataset.originalHtml;
}

async function submitBookingToDatabase(method) {
    const token = localStorage.getItem('userToken');
    const totalMinutes = selectedServices.reduce((sum, s) => sum + (s.duration_minutes || 30), 0);

    // Price and duration are recomputed server-side; the payment channel is
    // chosen by the patient on PayMongo's page, so it is NOT sent from here.
    const payload = {
        appointment_date: selectedDateValue,
        time_slot: selectedStartTime,
        end_time_slot: selectedEndTime,
        estimated_duration_minutes: totalMinutes,
        doctor_id: selectedDoctorId || null,
        service_id: selectedServices[0].service_id,
        service_ids: selectedServices.map(s => s.service_id),
        patient_note: sanitizeInput(document.getElementById('PNote')?.value, 250),
        payment_method: method
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

        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            const err = new Error(result.message || 'Failed to complete booking.');
            err.status = response.status;
            throw err;
        }

        // ── Online: hand off to PayMongo. The booking only becomes final once
        // the server receives PayMongo's payment-confirmed webhook.
        if (method === 'online') {
            if (!result.checkout_url) {
                throw new Error('The payment page could not be opened. Please try again or choose Pay in Clinic.');
            }
            window.location.href = result.checkout_url;
            return;
        }

        // ── Cash: booking is recorded immediately as pending.
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
        resetPayOnlineBtn();
        showValidationModal('Booking Error: ' + error.message);

        // Slot was taken by someone else: close the summary and refresh slots.
        if (error.status === 409) {
            document.getElementById('receipt-modal')?.classList.add('hidden');
            selectedStartTime = '';
            selectedEndTime = '';
            const st = document.getElementById('selected-time');
            const et = document.getElementById('selected-end-time');
            if (st) st.value = '';
            if (et) et.value = '';
            if (selectedDoctorId && selectedDateValue) {
                fetchAvailableSlotsForDoctor(selectedDoctorId, selectedDateValue);
            }
        }
    }
}