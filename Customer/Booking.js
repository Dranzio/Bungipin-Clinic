// ── BOOKING CONTROLLER (Clean 30-Min Intervals, Strict Advance Limit & Slot Validation) ──
const API_BASE_URL = window.BACKEND_API_BASE_URL || '';
const MAX_ADVANCE_MONTHS = 6; // Limit booking to 6 months in advance

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

function sanitizeInput(str, maxLen = 100) {
    return String(str ?? '').trim().replace(/[<>]/g, '').slice(0, maxLen);
}

// ── State Management ────────────────────────────────────────────────────────
let availableServices = [];
let availableDoctors  = [];
let selectedServices  = [];
let selectedDoctorId  = null;
let selectedDateValue = '';
let selectedStartTime = '';
let selectedEndTime   = '';

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
            { service_id: 1, label: 'Dental Checkup & Consultation', price: 500, duration_minutes: 30, required_specialization: 'General Dentist', description: 'Comprehensive oral examination and diagnostic consultation.', icon: '../assets/Checkup.png' },
            { service_id: 2, label: 'Oral Prophylaxis (Cleaning)', price: 1500, duration_minutes: 45, required_specialization: 'General Dentist', description: 'Professional teeth cleaning to remove plaque and tartar buildup.', icon: '../assets/cleaning.png' },
            { service_id: 3, label: 'Tooth Restoration (Pasta)', price: 1200, duration_minutes: 30, required_specialization: 'General Dentist', description: 'Composite tooth filling to restore decayed or chipped teeth.', icon: '../assets/pasta.png' },
            { service_id: 4, label: 'Laser Teeth Whitening', price: 4500, duration_minutes: 60, required_specialization: 'General Dentist', description: 'Advanced laser technology for professional shade brightening.', icon: '../assets/whitening.png' },
            { service_id: 5, label: 'Braces Installation / Adjustment', price: 3500, duration_minutes: 60, required_specialization: 'Orthodontist', description: 'Orthodontic alignment and bracket adjustments.', icon: '../assets/logo.png' },
            { service_id: 6, label: 'Root Canal Treatment', price: 6500, duration_minutes: 90, required_specialization: 'Endodontist', description: 'Therapy to treat infected tooth pulp and save the natural tooth.', icon: '../assets/logo.png' },
            { service_id: 7, label: 'Impacted Wisdom Tooth Surgery', price: 5000, duration_minutes: 60, required_specialization: 'Oral Surgeon', description: 'Minor oral surgical extraction for impacted third molars.', icon: '../assets/logo.png' }
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

// ── 2. Render Services ──────────────────────────────────────────────────────
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
            // 🔴 INCOMPATIBLE WITH CURRENT DOCTOR
            card.className = `flex flex-col w-full max-w-[240px] h-[285px] justify-between items-center text-center rounded-2xl border-2 border-dashed border-red-400 bg-red-50/50 transition-all duration-200 cursor-not-allowed p-4 pt-7 relative shadow-sm opacity-70 select-none overflow-hidden`;

            card.innerHTML = `
                <div class="absolute -top-0.5 inset-x-0 bg-red-600 text-white text-[9px] font-black uppercase tracking-wider py-0.5 text-center shadow-sm">
                    ⚠️ Requires: ${escapeHtml(reqSpec)}
                </div>

                <div class="absolute top-3 left-2.5 bg-amber-100 border border-amber-500/30 text-amber-900 text-[10px] font-extrabold px-2 py-0.5 rounded-full flex items-center gap-1">
                    <i class="fa-regular fa-clock text-[9px]"></i> ${duration}m
                </div>

                <h3 class="font-extrabold text-sm sm:text-base break-words w-full text-gray-600 line-clamp-2 px-1 mt-4">
                    ${escapeHtml(service.label)}
                </h3>

                <img src="${imgSrc}" class="w-14 h-14 object-contain my-1 grayscale opacity-60" alt="${escapeHtml(service.label)}" onerror="this.src='../assets/logowithtitle.png'">

                <div class="w-full pt-1.5 border-t border-red-200 flex flex-col items-center">
                    <span class="text-[10px] font-bold text-red-600 leading-tight">Unavailable with ${escapeHtml(doctorSpec)}</span>
                    <span class="font-black text-xs text-gray-500 mt-0.5">₱${Number(service.price).toLocaleString()}</span>
                </div>
            `;

            card.addEventListener('click', () => {
                showValidationModal(`Cannot add "${service.label}".\n\nDr. ${selectedDoctor.name} is a ${doctorSpec}. This procedure requires a ${reqSpec}.\n\nPlease select a ${reqSpec} from the dentist dropdown above to book this service.`);
            });

        } else {
            // ✅ COMPATIBLE / ACTIVE CARD
            card.className = `flex flex-col w-full max-w-[240px] h-[285px] justify-between items-center text-center rounded-2xl border-2 transition-all duration-200 cursor-pointer p-4 pt-7 relative shadow-sm hover:scale-[1.02] overflow-hidden ${
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

                <h3 class="font-extrabold text-sm sm:text-base break-words w-full text-[#2A1001] line-clamp-2 px-1 mt-4">
                    ${escapeHtml(service.label)}
                </h3>

                <img src="${imgSrc}" class="w-16 h-16 object-contain my-1" alt="${escapeHtml(service.label)}" onerror="this.src='../assets/logowithtitle.png'">

                <button type="button" class="viewServiceDetailBtn bg-[#D3DCBE] hover:bg-[#c4cfab] text-[#2A1001] px-3.5 py-1 rounded-full text-xs font-extrabold transition shadow-xs flex items-center gap-1.5 cursor-pointer mb-1 z-10 active:scale-95" data-service-id="${service.service_id}">
                    <i class="fa-solid fa-circle-info text-[#667733]"></i> View Details
                </button>

                <div class="w-full pt-1.5 border-t border-[#2A1001]/10 flex justify-between items-center px-2">
                    <span class="text-[10px] font-bold text-[#2A1001]/60 uppercase">Price:</span>
                    <span class="font-black text-sm text-[#2A1001]">₱${Number(service.price).toLocaleString()}</span>
                </div>
            `;

            card.addEventListener('click', (e) => {
                if (e.target.closest('.viewServiceDetailBtn')) return;
                toggleServiceSelection(service);
            });
        }

        serviceGrid.appendChild(card);
    });

    document.querySelectorAll('.viewServiceDetailBtn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const sid = btn.dataset.serviceId;
            const serv = availableServices.find(s => s.service_id == sid);
            if (serv) openServiceDetailModal(serv);
        });
    });

    updateLiveCalculations();
}

function openServiceDetailModal(service) {
    const modal = document.getElementById('service-detail-modal');
    if (!modal) return;

    document.getElementById('modalServiceTitle').textContent = service.label;
    document.getElementById('modalServiceSpec').textContent = `Specialization: ${service.required_specialization || 'General Dentist'}`;
    document.getElementById('modalServiceDesc').textContent = service.description || 'Standard high-quality dental care procedure carried out with clinical equipment.';
    document.getElementById('modalServiceDuration').textContent = formatDuration(getEstimatedDuration(service));
    document.getElementById('modalServicePrice').textContent = `₱${Number(service.price).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

    const selectBtn = document.getElementById('modalServiceSelectBtn');
    const isSelected = selectedServices.some(s => s.service_id == service.service_id);
    selectBtn.textContent = isSelected ? 'Deselect Service' : 'Select This Service';
    selectBtn.className = `mt-2 w-full py-2.5 font-bold rounded-full transition shadow-md cursor-pointer text-sm ${isSelected ? 'bg-[#D9534F] hover:bg-[#c94541] text-white' : 'bg-[#667733] hover:bg-[#556022] text-white'}`;

    selectBtn.onclick = () => {
        toggleServiceSelection(service);
        modal.classList.add('hidden');
    };

    modal.classList.remove('hidden');
}

document.getElementById('close-service-detail')?.addEventListener('click', () => {
    document.getElementById('service-detail-modal').classList.add('hidden');
});

// ── 3. Toggle Service Selection ─────────────────────────────────────────────
function toggleServiceSelection(service) {
    const index = selectedServices.findIndex(s => s.service_id == service.service_id);
    const duration = getEstimatedDuration(service);
    const reqSpec = service.required_specialization || 'General Dentist';

    if (index > -1) {
        selectedServices.splice(index, 1);
    } else {
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

    if (displayTotal) displayTotal.textContent = `₱${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    if (displayDuration) displayDuration.textContent = formatDuration(totalMinutes);

    const slotInfoBadge = document.getElementById('slotInfoBadge');
    if (slotInfoBadge) {
        slotInfoBadge.textContent = totalMinutes > 0 ? `Est. Session Window: ${formatDuration(totalMinutes)}` : '';
    }
}

// ── 4. Load Doctors ─────────────────────────────────────────────────────────
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

// ── 5. Dynamic Time Slots Fetcher ───────────────────────────────────────────
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
            btn.className = 'flex flex-col w-full py-2 px-3 bg-gray-100 rounded-2xl border border-gray-200 items-center justify-center text-center text-gray-400 text-xs cursor-not-allowed opacity-60 select-none pointer-events-none';
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
    const today = new Date();

    const maxDate = new Date(today);
    maxDate.setMonth(maxDate.getMonth() + MAX_ADVANCE_MONTHS);

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

        if (prevButton) {
            const isCurrentMonth = (year === today.getFullYear() && month === today.getMonth());
            prevButton.style.opacity = isCurrentMonth ? '0.3' : '1';
            prevButton.style.pointerEvents = isCurrentMonth ? 'none' : 'auto';
        }

        if (nextButton) {
            const isMaxMonth = (year > maxDate.getFullYear()) || (year === maxDate.getFullYear() && month >= maxDate.getMonth());
            nextButton.style.opacity = isMaxMonth ? '0.3' : '1';
            nextButton.style.pointerEvents = isMaxMonth ? 'none' : 'auto';
        }

        const prevMonthLastDay = new Date(year, month, 0).getDate();
        for (let i = firstDay; i > 0; i--) {
            const dayDiv = document.createElement('div');
            dayDiv.className = 'w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center font-medium text-gray-300 select-none text-xs sm:text-sm';
            dayDiv.textContent = prevMonthLastDay - i + 1;
            daysContainer.appendChild(dayDiv);
        }

        for (let i = 1; i <= lastDay; i++) {
            const cellDate = new Date(year, month, i);
            const isPast = cellDate < new Date(today.getFullYear(), today.getMonth(), today.getDate());
            const isBeyondLimit = cellDate > maxDate;
            const isDisabled = isPast || isBeyondLimit;

            const dayDiv = document.createElement('div');
            dayDiv.textContent = i;

            if (isDisabled) {
                dayDiv.className = 'w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center font-medium text-xs sm:text-sm bg-gray-50 text-gray-300 cursor-not-allowed select-none';
            } else {
                dayDiv.className = 'w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center font-bold text-xs sm:text-sm text-[#2A1001] cursor-pointer transition-all hover:bg-[#D7E3A5] hover:scale-110';

                if (i === today.getDate() && month === today.getMonth() && year === today.getFullYear()) {
                    dayDiv.classList.add('border-2', 'border-[#667733]', 'bg-[#FDFCE9]');
                }

                const formattedMonth = String(month + 1).padStart(2, '0');
                const formattedDay = String(i).padStart(2, '0');
                const sqlDateStr = `${year}-${formattedMonth}-${formattedDay}`;

                if (selectedDateValue === sqlDateStr) {
                    dayDiv.classList.add('bg-[#667733]', 'text-white');
                }

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

// ── 7. Booking Form & Immediate Error Validation ─────────────────────────────
function initBookingForm() {
    const bookingForm           = document.getElementById('booking-form');
    const submitBtn             = document.getElementById('submit-btn');
    const receiptModal          = document.getElementById('receipt-modal');
    const closeModalBtn         = document.getElementById('close-modal');
    const receiptContent        = document.getElementById('receipt-content');
    const payOnlineBtn          = document.getElementById('pay-online-btn');
    const payCashBtn            = document.getElementById('pay-cash-btn');

    if (!bookingForm) return;

    bookingForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        // 1. Client-side Form Checks
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

        const totalMinutes = selectedServices.reduce((sum, s) => sum + (s.duration_minutes || 30), 0);

        // 2. 🛑 FAST PRE-VALIDATION CHECK: Check overlaps/conflicts BEFORE opening summary modal
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Checking Availability…';
        }

        try {
            const token = localStorage.getItem('userToken');
            const valRes = await fetch(`${API_BASE_URL}/api/appointments/validate-slot`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
                },
                body: JSON.stringify({
                    appointment_date: selectedDateValue,
                    time_slot: selectedStartTime,
                    end_time_slot: selectedEndTime,
                    doctor_id: selectedDoctorId,
                    duration_minutes: totalMinutes
                })
            });

            const valData = await valRes.json().catch(() => ({}));

            if (!valRes.ok) {
                // ❌ Overlap or error detected: DO NOT show summary modal! Show error directly!
                if (receiptModal) receiptModal.classList.add('hidden');
                showValidationModal(valData.message || 'The selected time slot is unavailable.');
                
                // Refresh slots and clear selection
                selectedStartTime = '';
                selectedEndTime = '';
                document.getElementById('selected-time').value = '';
                document.getElementById('selected-end-time').value = '';
                if (selectedDoctorId && selectedDateValue) {
                    fetchAvailableSlotsForDoctor(selectedDoctorId, selectedDateValue);
                }
                return;
            }
        } catch (err) {
            console.error('Validation check error:', err);
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Review Booking & Pay';
            }
        }

        // 3. ✅ Slot is completely valid: Show summary modal now
        const noteVal = sanitizeInput(document.getElementById('PNote')?.value, 250) || 'None';
        const docObj  = availableDoctors.find(d => d.doctor_id == selectedDoctorId);
        const doctorName = docObj ? docObj.name : 'Attending Dentist';
        
        const totalAmount = selectedServices.reduce((sum, s) => sum + s.price, 0);
        const subtotal = totalAmount / 1.12;
        const vatAmount = totalAmount - subtotal;

        const servicesListHtml = selectedServices.map(s => `
            <div class="flex justify-between items-center py-1 text-xs sm:text-sm border-b border-black/10 gap-2">
                <div class="min-w-0">
                    <span class="font-bold text-[#2A1001] break-words">${escapeHtml(s.label)}</span>
                    <span class="text-[10px] text-gray-500 ml-1">(${s.duration_minutes || 30}m)</span>
                </div>
                <span class="font-black text-[#2A1001] shrink-0">₱${s.price.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
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

            <div class="border-t border-black/15 pt-2 flex flex-col gap-1 text-xs">
                <div class="flex justify-between items-center text-[#2A1001]/80">
                    <span>Subtotal (VAT Exclusive):</span>
                    <span class="font-bold">₱${subtotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div class="flex justify-between items-center text-[#2A1001]/80">
                    <span>Value Added Tax (12% VAT):</span>
                    <span class="font-bold">₱${vatAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div class="flex justify-between items-center pt-1.5 border-t border-black/20 text-sm sm:text-base font-black text-[#667733]">
                    <span>Total Amount Due (VAT Inclusive):</span>
                    <span>₱${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
            </div>

            <div class="bg-white/80 p-2 sm:p-2.5 rounded-xl border border-black/10 text-xs mt-1">
                <span class="font-bold">Patient Note:</span>
                <p class="italic text-[#2A1001]/80 mt-0.5 break-words">${escapeHtml(noteVal)}</p>
            </div>
        `;

        receiptModal.classList.remove('hidden');
    });

    if (closeModalBtn) closeModalBtn.addEventListener('click', () => receiptModal.classList.add('hidden'));

    if (payOnlineBtn) {
        payOnlineBtn.addEventListener('click', () => {
            if (payOnlineBtn.disabled) return;
            payOnlineBtn.disabled = true;
            payOnlineBtn.dataset.originalHtml = payOnlineBtn.innerHTML;
            payOnlineBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Opening secure checkout...';
            submitBookingToDatabase('online');
        });

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
}

function showValidationModal(message, focusTarget = null, customTitle = null, iconType = 'warning') {
    const modal = document.getElementById('validation-modal');
    const titleEl = document.getElementById('validation-modal-title');
    const textEl = document.getElementById('validation-modal-text');
    const iconEl = document.getElementById('validation-modal-icon');
    const iconWrap = document.getElementById('validation-modal-icon-wrap');
    const okBtn = document.getElementById('validation-modal-ok');

    if (!modal || !textEl || !okBtn) {
        alert(message);
        return;
    }

    const cleanMessage = String(message || '').replace(/^Booking Error:\s*/i, '').trim();

    let finalTitle = customTitle;
    if (!finalTitle) {
        const lower = cleanMessage.toLowerCase();
        if (lower.includes('3 active') || lower.includes('booking limit') || lower.includes('active appointment')) {
            finalTitle = 'Booking Limit Reached';
            iconType = 'limit';
        } else if (lower.includes('specializ') || lower.includes('cannot perform') || lower.includes('requires a')) {
            finalTitle = 'Specialist Required';
            iconType = 'specialist';
        } else if (lower.includes('already have an appointment') || lower.includes('cannot book overlapping') || lower.includes('overlapping appointments')) {
            finalTitle = 'Schedule Overlap Conflict';
            iconType = 'clock';
        } else if (lower.includes('just been reserved') || lower.includes('different slot') || lower.includes('already booked')) {
            finalTitle = 'Slot Unavailable';
            iconType = 'clock';
        } else if (lower.includes('payment') || lower.includes('checkout') || lower.includes('paymongo')) {
            finalTitle = 'Payment Notice';
            iconType = 'payment';
        } else if (lower.includes('please select') || lower.includes('please pick') || lower.includes('missing')) {
            finalTitle = 'Incomplete Selection';
            iconType = 'warning';
        } else if (lower.includes('deselected') || lower.includes('adjusted')) {
            finalTitle = 'Services Adjusted';
            iconType = 'info';
        } else {
            finalTitle = 'Notice';
            iconType = 'warning';
        }
    }

    if (titleEl) titleEl.textContent = finalTitle;
    if (textEl) textEl.textContent = cleanMessage;

    if (iconEl && iconWrap) {
        if (iconType === 'limit') {
            iconWrap.className = 'w-14 h-14 rounded-full bg-red-100 flex items-center justify-center';
            iconEl.className = 'fa-solid fa-circle-exclamation text-red-600 text-2xl';
        } else if (iconType === 'specialist') {
            iconWrap.className = 'w-14 h-14 rounded-full bg-indigo-100 flex items-center justify-center';
            iconEl.className = 'fa-solid fa-user-doctor text-indigo-600 text-2xl';
        } else if (iconType === 'clock') {
            iconWrap.className = 'w-14 h-14 rounded-full bg-amber-100 flex items-center justify-center';
            iconEl.className = 'fa-solid fa-clock-rotate-left text-amber-600 text-2xl';
        } else if (iconType === 'info') {
            iconWrap.className = 'w-14 h-14 rounded-full bg-blue-100 flex items-center justify-center';
            iconEl.className = 'fa-solid fa-circle-info text-blue-600 text-2xl';
        } else {
            iconWrap.className = 'w-14 h-14 rounded-full bg-amber-50 flex items-center justify-center';
            iconEl.className = 'fa-solid fa-triangle-exclamation text-amber-500 text-2xl';
        }
    }

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

    const sub = Number(amount || 0) / 1.12;
    const vat = Number(amount || 0) - sub;

    details.innerHTML = `
        <div class="flex justify-between gap-2"><span class="font-bold text-[#2A1001]/60 shrink-0">Date:</span><span class="font-semibold text-right">${escapeHtml(date || '')}</span></div>
        <div class="flex justify-between gap-2"><span class="font-bold text-[#2A1001]/60 shrink-0">Time:</span><span class="font-semibold text-right">${escapeHtml(time || '')}</span></div>
        <div class="flex justify-between gap-2"><span class="font-bold text-[#2A1001]/60 shrink-0">Dentist:</span><span class="font-semibold text-right">${escapeHtml(doctorName || '')}</span></div>
        <div class="flex justify-between gap-2"><span class="font-bold text-[#2A1001]/60 shrink-0">Services:</span><span class="font-semibold text-right break-words">${escapeHtml(servicesLabel || '')}</span></div>
        <div class="flex justify-between gap-2 text-xs pt-1 border-t border-black/10"><span class="text-[#2A1001]/60">Subtotal:</span><span>₱${sub.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
        <div class="flex justify-between gap-2 text-xs"><span class="text-[#2A1001]/60">12% VAT:</span><span>₱${vat.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
        <div class="flex justify-between border-t border-black/10 pt-1.5 mt-1"><span class="font-bold text-[#2A1001]/60">Total Amount:</span><span class="font-black text-[#667733]">₱${Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
    `;
    modal.classList.remove('hidden');

    okBtn.onclick = () => {
        modal.classList.add('hidden');
        window.location.href = 'History.html';
    };
}

// ── 8. Submit Appointment ───────────────────────────────────────────────────
function resetPayOnlineBtn() {
    const btn = document.getElementById('pay-online-btn');
    if (!btn) return;
    btn.disabled = false;
    if (btn.dataset.originalHtml) btn.innerHTML = btn.dataset.originalHtml;
}

async function submitBookingToDatabase(method) {
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

        if (method === 'online') {
            if (!result.checkout_url) {
                throw new Error('The payment page could not be opened. Please try again or choose Pay in Clinic.');
            }
            window.location.href = result.checkout_url;
            return;
        }

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