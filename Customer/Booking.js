// ── BOOKING CONTROLLER (Clean 30-Min Intervals, Advance Booking Limits & Mobile-Friendly Cards) ───────
const API_BASE_URL = window.BACKEND_API_BASE_URL || '';
const MAX_ADVANCE_MONTHS = 6; // Set to 6 for 6 months (or 12 for 1 year)

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
let currentPaymentChannel = 'gcash';

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
    initPaymentChannels();
    initProcedureModal();
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
            { service_id: 1, label: 'Dental Checkup & Consultation', price: 500, duration_minutes: 30, required_specialization: 'General Dentist', description: 'Comprehensive oral assessment, clinical examination, and treatment planning by our dental team.', icon: '../assets/Checkup.png' },
            { service_id: 2, label: 'Oral Prophylaxis (Cleaning)', price: 1500, duration_minutes: 45, required_specialization: 'General Dentist', description: 'Professional scaling and polishing to thoroughly remove plaque, tartar, and surface stains from teeth.', icon: '../assets/cleaning.png' },
            { service_id: 3, label: 'Tooth Restoration (Pasta)', price: 1200, duration_minutes: 30, required_specialization: 'General Dentist', description: 'Composite tooth-colored resin filling to restore chipped or decayed tooth structure seamlessly.', icon: '../assets/pasta.png' },
            { service_id: 4, label: 'Laser Teeth Whitening', price: 4500, duration_minutes: 60, required_specialization: 'General Dentist', description: 'Advanced in-office cosmetic whitening treatment using laser technology for immediate brightening.', icon: '../assets/whitening.png' },
            { service_id: 5, label: 'Braces Installation / Adjustment', price: 3500, duration_minutes: 60, required_specialization: 'Orthodontist', description: 'Orthodontic bracket alignment and wire adjustments to straighten teeth and correct bite issues.', icon: '../assets/logo.png' },
            { service_id: 6, label: 'Root Canal Treatment', price: 6500, duration_minutes: 90, required_specialization: 'Endodontist', description: 'Therapeutic endodontic procedure to clean, disinfect, and seal infected tooth pulp and root canals.', icon: '../assets/logo.png' },
            { service_id: 7, label: 'Impacted Wisdom Tooth Surgery', price: 5000, duration_minutes: 60, required_specialization: 'Oral Surgeon', description: 'Specialized minor oral surgery to safely remove deeply impacted, painful, or misaligned wisdom teeth.', icon: '../assets/logo.png' }
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

// ── 2. Render Services (Clean Mobile-First Cards) ───────────────────────────
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
        const descriptionText = service.description ? service.description : 'Standard clinical dental procedure.';

        card.dataset.serviceId = service.service_id;

        const imgSrc = (service.icon && (/^(\/|https?:\/\/|\.\.\/assets\/)/.test(service.icon)))
            ? service.icon
            : fallbackIcon(service.label);

        if (!isCompatible && selectedDoctor) {
            // 🔴 Incompatible Specialist Service Card
            card.className = 'w-full max-w-[270px] min-h-[290px] rounded-3xl border-2 border-dashed border-red-300 bg-red-50/60 p-4 pt-6 flex flex-col justify-between items-center text-center shadow-sm opacity-80 cursor-not-allowed relative select-none';

            card.innerHTML = `
                <div class="absolute -top-0.5 inset-x-0 bg-red-600 text-white text-[9px] font-black uppercase tracking-wider py-0.5 text-center shadow-sm rounded-t-2xl">
                    ⚠️ Requires: ${escapeHtml(reqSpec)}
                </div>

                <div class="w-full flex justify-between items-center">
                    <span class="bg-amber-100 border border-amber-500/30 text-amber-900 text-[10px] font-extrabold px-2 py-0.5 rounded-full flex items-center gap-1">
                        <i class="fa-regular fa-clock text-[9px]"></i> ${duration}m
                    </span>
                    <div class="w-7 h-7 rounded-full border-2 border-gray-300 bg-gray-100 flex items-center justify-center">
                        <i class="fa-solid fa-ban text-xs text-gray-400"></i>
                    </div>
                </div>

                <h3 class="font-extrabold text-sm break-words w-full text-gray-700 line-clamp-2 px-1 mt-1">
                    ${escapeHtml(service.label)}
                </h3>

                <img src="${imgSrc}" class="w-14 h-14 object-contain my-2 grayscale opacity-50" alt="${escapeHtml(service.label)}" onerror="this.src='../assets/logowithtitle.png'">

                <div class="w-full flex flex-col gap-1 pt-2 border-t border-red-200">
                    <div class="flex justify-between items-center px-1">
                        <span class="text-[10px] font-bold text-red-600">Unavailable with ${escapeHtml(doctorSpec)}</span>
                        <span class="font-black text-xs text-gray-500">₱${Number(service.price).toLocaleString()}</span>
                    </div>
                    <button type="button" class="view-proc-btn w-full py-1 bg-white hover:bg-gray-100 text-gray-700 font-bold rounded-xl border border-black/10 text-[11px] flex items-center justify-center gap-1 cursor-pointer transition">
                        <i class="fa-solid fa-circle-info text-[#667733]"></i> Read Procedure
                    </button>
                </div>
            `;

            card.querySelector('.view-proc-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                openProcedureModal(service, isSelected, false, doctorSpec);
            });

            card.addEventListener('click', () => {
                showValidationModal(
                    `Dr. ${selectedDoctor.name} specializes in ${doctorSpec}.\n\n"${service.label}" requires a ${reqSpec}.\n\nPlease select a qualified specialist from the dentist dropdown.`,
                    null,
                    'Specialist Required',
                    'specialist'
                );
            });

        } else {
            // ✅ Active / Qualified Service Card
            card.className = `w-full max-w-[270px] min-h-[290px] rounded-3xl border-2 p-4 pt-4 flex flex-col justify-between items-center text-center shadow-sm transition-all duration-200 cursor-pointer relative ${
                isSelected 
                    ? 'bg-[#D7E3A5] border-[#667733] ring-2 ring-[#667733]' 
                    : 'bg-white border-black hover:bg-[#FDFCE9] hover:scale-[1.01]'
            }`;

            card.innerHTML = `
                <div class="w-full flex justify-between items-center">
                    <span class="bg-amber-100 border border-amber-500/30 text-amber-900 text-[10px] font-extrabold px-2 py-0.5 rounded-full flex items-center gap-1">
                        <i class="fa-regular fa-clock text-[9px]"></i> ${duration}m
                    </span>

                    <div class="circle-select-btn w-7 h-7 rounded-full border-2 border-black flex items-center justify-center transition-all ${isSelected ? 'bg-[#667733] text-white shadow-sm' : 'bg-white text-transparent hover:border-[#667733]'}">
                        <i class="fa-solid fa-check text-xs"></i>
                    </div>
                </div>

                <h3 class="font-extrabold text-sm sm:text-base break-words w-full text-[#2A1001] line-clamp-2 px-1 mt-1">
                    ${escapeHtml(service.label)}
                </h3>

                <img src="${imgSrc}" class="w-16 h-16 object-contain my-1" alt="${escapeHtml(service.label)}" onerror="this.src='../assets/logowithtitle.png'">

                <div class="w-full flex flex-col gap-1.5 pt-2 border-t border-black/10">
                    <div class="flex justify-between items-center px-1">
                        <span class="text-[10px] font-bold text-[#2A1001]/60 uppercase">Price:</span>
                        <span class="font-black text-sm text-[#667733]">₱${Number(service.price).toLocaleString()}</span>
                    </div>

                    <button type="button" class="view-proc-btn w-full py-1.5 bg-[#ECF5E2] hover:bg-[#F6FAF2] active:scale-95 text-[#2A1001] font-extrabold rounded-xl border border-black/10 text-[11px] flex items-center justify-center gap-1.5 cursor-pointer transition">
                        <i class="fa-solid fa-circle-info text-[#667733]"></i> View Procedure Info
                    </button>
                </div>
            `;

            card.querySelector('.view-proc-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                openProcedureModal(service, isSelected, true);
            });

            card.addEventListener('click', () => toggleServiceSelection(service));
        }

        serviceGrid.appendChild(card);
    });

    updateLiveCalculations();
}

// ── 3. Procedure Modal Controller ───────────────────────────────────────────
let activeModalService = null;

function initProcedureModal() {
    const modal = document.getElementById('procedure-details-modal');
    const closeX = document.getElementById('close-procedure-modal-btn');
    const closeBtn = document.getElementById('proc-modal-close-btn');
    const toggleBtn = document.getElementById('proc-modal-toggle-btn');

    const closeModal = () => modal?.classList.add('hidden');

    if (closeX) closeX.addEventListener('click', closeModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            if (activeModalService) {
                toggleServiceSelection(activeModalService);
                closeModal();
            }
        });
    }
}

function openProcedureModal(service, isCurrentlySelected, isCompatible = true, doctorSpec = '') {
    const modal = document.getElementById('procedure-details-modal');
    const titleEl = document.getElementById('proc-modal-title');
    const specEl = document.getElementById('proc-modal-spec-badge');
    const durationEl = document.getElementById('proc-modal-duration');
    const priceEl = document.getElementById('proc-modal-price');
    const descEl = document.getElementById('proc-modal-description');
    const iconEl = document.getElementById('proc-modal-icon');
    const toggleBtn = document.getElementById('proc-modal-toggle-btn');

    if (!modal) return;

    activeModalService = service;

    const duration = getEstimatedDuration(service);
    const reqSpec = service.required_specialization || 'General Dentist';
    const imgSrc = (service.icon && (/^(\/|https?:\/\/|\.\.\/assets\/)/.test(service.icon)))
        ? service.icon
        : fallbackIcon(service.label);

    if (titleEl) titleEl.textContent = service.label;
    if (specEl) specEl.textContent = `Requires: ${reqSpec}`;
    if (durationEl) durationEl.textContent = formatDuration(duration);
    if (priceEl) priceEl.textContent = `₱${Number(service.price).toLocaleString()}`;
    if (iconEl) iconEl.src = imgSrc;
    if (descEl) descEl.textContent = service.description ? service.description : 'Standard clinic procedure with professional dental care.';

    if (toggleBtn) {
        if (!isCompatible) {
            toggleBtn.disabled = true;
            toggleBtn.className = 'flex-1 py-3 bg-gray-200 text-gray-500 font-bold rounded-full cursor-not-allowed text-xs sm:text-sm';
            toggleBtn.innerHTML = `Unavailable with ${escapeHtml(doctorSpec || 'Dentist')}`;
        } else {
            toggleBtn.disabled = false;
            if (isCurrentlySelected) {
                toggleBtn.className = 'flex-1 py-3 bg-[#D9534F] hover:bg-red-700 text-white font-bold rounded-full shadow-md active:scale-95 transition cursor-pointer text-xs sm:text-sm flex items-center justify-center gap-1.5';
                toggleBtn.innerHTML = '<i class="fa-solid fa-xmark"></i> Remove From Selection';
            } else {
                toggleBtn.className = 'flex-1 py-3 bg-[#667733] hover:bg-[#556022] text-white font-bold rounded-full shadow-md active:scale-95 transition cursor-pointer text-xs sm:text-sm flex items-center justify-center gap-1.5';
                toggleBtn.innerHTML = '<i class="fa-solid fa-check"></i> Select This Treatment';
            }
        }
    }

    modal.classList.remove('hidden');
}

// ── 4. Toggle Service Selection ─────────────────────────────────────────────
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
                showValidationModal(
                    `Cannot add "${service.label}". Dr. ${currentDoc.name} specializes in ${currentDoc.specialization} and cannot perform this treatment.`,
                    null,
                    'Specialist Required',
                    'specialist'
                );
                return;
            }
        }

        selectedServices.push({
            service_id: service.service_id,
            label: service.label,
            price: Number(service.price || 0),
            duration_minutes: duration,
            description: service.description || '',
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
    const onlineAmountText = document.getElementById('onlinePayAmountText');

    if (displayTotal) displayTotal.textContent = `₱${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    if (onlineAmountText) onlineAmountText.textContent = `₱${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    if (displayDuration) displayDuration.textContent = formatDuration(totalMinutes);

    const slotInfoBadge = document.getElementById('slotInfoBadge');
    if (slotInfoBadge) {
        slotInfoBadge.textContent = totalMinutes > 0 ? `Est. Session Window: ${formatDuration(totalMinutes)}` : '';
    }
}

// ── 5. Doctor Selection ─────────────────────────────────────────────────────
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
            opt.textContent = `${doc.name} (${docSpec}) — Incompatible with selected service/s`;
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
                showValidationModal(
                    `Some treatments were deselected because Dr. ${currentDoc.name} specializes in ${currentDoc.specialization}.`,
                    null,
                    'Specialization Update',
                    'info'
                );
            }
        }

        renderServiceCards();

        if (selectedDateValue && selectedDoctorId) {
            fetchAvailableSlotsForDoctor(selectedDoctorId, selectedDateValue);
        }
    });
}

// ── 6. Dynamic Time Slots Fetcher ───────────────────────────────────────────
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

// ── 7. Calendar Logic (Enforces 6 Months / 1 Year Advance Limit) ─────────────
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
    today.setHours(0, 0, 0, 0);

    // Max advance booking date (e.g., today + 6 months)
    const maxBookingDate = new Date(today);
    maxBookingDate.setMonth(maxBookingDate.getMonth() + MAX_ADVANCE_MONTHS);

    function isDateDisabled(dateString) {
        const checkDate = new Date(`${dateString}T00:00:00`);
        return checkDate < today || checkDate > maxBookingDate;
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

        // Disable "Previous" button if viewing current month/year
        if (prevButton) {
            const isCurrentMonth = (year === today.getFullYear() && month === today.getMonth());
            prevButton.disabled = isCurrentMonth;
            prevButton.classList.toggle('opacity-30', isCurrentMonth);
            prevButton.classList.toggle('cursor-not-allowed', isCurrentMonth);
        }

        // Disable "Next" button if viewing maximum allowed month/year
        if (nextButton) {
            const isMaxMonth = (year > maxBookingDate.getFullYear()) || (year === maxBookingDate.getFullYear() && month >= maxBookingDate.getMonth());
            nextButton.disabled = isMaxMonth;
            nextButton.classList.toggle('opacity-30', isMaxMonth);
            nextButton.classList.toggle('cursor-not-allowed', isMaxMonth);
        }

        const prevMonthLastDay = new Date(year, month, 0).getDate();
        for (let i = firstDay; i > 0; i--) {
            const dayDiv = document.createElement('div');
            dayDiv.className = 'w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center font-medium text-gray-300 select-none text-xs sm:text-sm';
            dayDiv.textContent = prevMonthLastDay - i + 1;
            daysContainer.appendChild(dayDiv);
        }

        for (let i = 1; i <= lastDay; i++) {
            const dayDiv = document.createElement('div');
            const formattedMonth = String(month + 1).padStart(2, '0');
            const formattedDay = String(i).padStart(2, '0');
            const sqlDateStr = `${year}-${formattedMonth}-${formattedDay}`;

            if (isDateDisabled(sqlDateStr)) {
                // Disabled Day (Past or Beyond 6 Months / 1 Year)
                dayDiv.className = 'w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center font-medium text-xs sm:text-sm bg-gray-100 text-gray-300 cursor-not-allowed select-none';
                dayDiv.textContent = i;
            } else {
                // Available Day
                dayDiv.className = 'w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center font-bold text-xs sm:text-sm text-[#2A1001] cursor-pointer transition-all hover:bg-[#D7E3A5] hover:scale-110';
                dayDiv.textContent = i;

                if (i === today.getDate() && month === today.getMonth() && year === today.getFullYear()) {
                    dayDiv.classList.add('border-2', 'border-[#667733]', 'bg-[#FDFCE9]');
                }

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

    if (prevButton) {
        prevButton.addEventListener('click', () => {
            const isCurrentMonth = (currentDate.getFullYear() === today.getFullYear() && currentDate.getMonth() === today.getMonth());
            if (!isCurrentMonth) {
                currentDate.setMonth(currentDate.getMonth() - 1);
                renderCalendar(currentDate);
            }
        });
    }

    if (nextButton) {
        nextButton.addEventListener('click', () => {
            const isMaxMonth = (currentDate.getFullYear() > maxBookingDate.getFullYear()) || (currentDate.getFullYear() === maxBookingDate.getFullYear() && currentDate.getMonth() >= maxBookingDate.getMonth());
            if (!isMaxMonth) {
                currentDate.setMonth(currentDate.getMonth() + 1);
                renderCalendar(currentDate);
            }
        });
    }

    renderCalendar(currentDate);
}

// ── 8. Philippine Payment Channels ──────────────────────────────────────────
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
                        <input type="tel" id="gcash-mobile" placeholder="09XX XXX XXXX" maxlength="11" class="w-full bg-white border border-black/20 rounded-lg px-2.5 py-1.5 text-xs sm:text-sm font-semibold outline-none focus:ring-2 focus:ring-[#005CEE]">
                    </div>
                    <div>
                        <label class="text-[11px] sm:text-xs font-bold text-[#2A1001] block mb-0.5">GCash Reference No.:</label>
                        <input type="text" id="gcash-ref" value="${refNumber}" readonly class="w-full bg-gray-100 border border-black/15 rounded-lg px-2.5 py-1.5 text-xs sm:text-sm font-semibold outline-none text-gray-500 cursor-not-allowed">
                    </div>
                </div>
            </div>
        `;
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
                        <input type="tel" id="maya-mobile" placeholder="09XX XXX XXXX" maxlength="11" class="w-full bg-white border border-black/20 rounded-lg px-2.5 py-1.5 text-xs sm:text-sm font-semibold outline-none focus:ring-2 focus:ring-green-600">
                    </div>
                    <div>
                        <label class="text-[11px] sm:text-xs font-bold text-[#2A1001] block mb-0.5">Maya Reference Code:</label>
                        <input type="text" id="maya-ref" value="${refNumber}" readonly class="w-full bg-gray-100 border border-black/15 rounded-lg px-2.5 py-1.5 text-xs sm:text-sm font-semibold outline-none text-gray-500 cursor-not-allowed">
                    </div>
                </div>
            </div>
        `;
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

// ── 9. Booking Form & Summary Modals ────────────────────────────────────────
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
            showValidationModal('Please select an attending dentist before continuing.', document.getElementById('doctorSelect'), 'Dentist Required', 'info');
            return;
        }
        if (selectedServices.length === 0) {
            showValidationModal('Please select at least one dental treatment.', null, 'Treatment Required', 'info');
            return;
        }
        if (!selectedDateValue) {
            showValidationModal('Please pick an appointment date on the calendar.', null, 'Date Required', 'info');
            return;
        }
        if (!selectedStartTime) {
            showValidationModal('Please select an available starting time slot.', null, 'Time Slot Required', 'info');
            return;
        }

        const noteVal = sanitizeInput(document.getElementById('PNote')?.value, 250) || 'None';
        const docObj  = availableDoctors.find(d => d.doctor_id == selectedDoctorId);
        const doctorName = docObj ? docObj.name : 'Attending Dentist';
        const totalAmount = selectedServices.reduce((sum, s) => sum + s.price, 0);
        const totalMinutes = selectedServices.reduce((sum, s) => sum + (s.duration_minutes || 30), 0);

        const servicesListHtml = selectedServices.map(s => `
            <div class="flex flex-col py-1.5 text-xs sm:text-sm border-b border-black/10 gap-0.5">
                <div class="flex justify-between items-center">
                    <div>
                        <span class="font-bold text-[#2A1001]">${escapeHtml(s.label)}</span>
                        <span class="text-[10px] text-gray-500 ml-1">(${s.duration_minutes || 30}m)</span>
                    </div>
                    <span class="font-black text-[#2A1001]">₱${s.price.toLocaleString()}</span>
                </div>
                ${s.description ? `<p class="text-[11px] text-[#2A1001]/70 italic">${escapeHtml(s.description)}</p>` : ''}
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
                if (!mob || mob.length < 11) { showValidationModal('Please enter a valid 11-digit GCash mobile number (09XXXXXXXXX).', mobField, 'Invalid Mobile', 'error'); return; }
                paymentRef = sanitizeInput(document.getElementById('gcash-ref')?.value, 30) || 'GCASH-' + Date.now();

            } else if (currentPaymentChannel === 'maya') {
                const mobField = document.getElementById('maya-mobile');
                const mob = sanitizeInput(mobField?.value, 11);
                if (!mob || mob.length < 11) { showValidationModal('Please enter a valid 11-digit Maya mobile number (09XXXXXXXXX).', mobField, 'Invalid Mobile', 'error'); return; }
                paymentRef = sanitizeInput(document.getElementById('maya-ref')?.value, 30) || 'MAYA-' + Date.now();

            } else if (currentPaymentChannel === 'gotyme') {
                const nameField = document.getElementById('gotyme-name');
                const accField = document.getElementById('gotyme-account');
                const name = sanitizeInput(nameField?.value, 60);
                const acc = sanitizeInput(accField?.value, 4);
                if (!name) { showValidationModal('Please input your GoTyme account name.', nameField, 'Account Name Required', 'error'); return; }
                if (!acc || acc.length < 4) { showValidationModal('Please enter the last 4 digits of your GoTyme card.', accField, 'Card Digits Required', 'error'); return; }
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

                if (!name || !num || !exp || !cvv) { showValidationModal('Please fill in complete Card details.', numField, 'Incomplete Card Details', 'error'); return; }
                paymentRef = 'CARD-' + num.replace(/\s/g, '').slice(-4) + '-' + Date.now();

            } else if (currentPaymentChannel === 'paypal') {
                const emailField = document.getElementById('paypal-email');
                const email = sanitizeInput(emailField?.value, 100);
                if (!email) { showValidationModal('Please enter your PayPal email address.', emailField, 'Email Required', 'error'); return; }
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

// ── 10. Validation & Success Modals ─────────────────────────────────────────
function showValidationModal(message, focusTarget = null, title = 'Incomplete Booking', type = 'warning') {
    const modal = document.getElementById('validation-modal');
    const titleEl = document.getElementById('validation-modal-title');
    const textEl = document.getElementById('validation-modal-text');
    const iconWrap = document.getElementById('validation-modal-icon-wrap');
    const iconEl = document.getElementById('validation-modal-icon');
    const okBtn = document.getElementById('validation-modal-ok');

    if (!modal || !textEl || !okBtn) {
        alert(message);
        return;
    }

    let finalTitle = title;
    const msgLower = String(message).toLowerCase();

    if (msgLower.includes('active appointments') || msgLower.includes('booking limit')) {
        finalTitle = 'Active Booking Limit Reached';
        if (iconWrap) iconWrap.className = 'w-14 h-14 rounded-full bg-amber-100 flex items-center justify-center text-amber-700';
        if (iconEl) iconEl.className = 'fa-solid fa-calendar-xmark text-2xl';
    } else if (msgLower.includes('specialist') || msgLower.includes('requires')) {
        finalTitle = 'Specialist Required';
        if (iconWrap) iconWrap.className = 'w-14 h-14 rounded-full bg-red-100 flex items-center justify-center text-red-600';
        if (iconEl) iconEl.className = 'fa-solid fa-user-doctor text-2xl';
    } else if (type === 'error') {
        if (iconWrap) iconWrap.className = 'w-14 h-14 rounded-full bg-red-100 flex items-center justify-center text-red-600';
        if (iconEl) iconEl.className = 'fa-solid fa-circle-exclamation text-2xl';
    } else {
        if (iconWrap) iconWrap.className = 'w-14 h-14 rounded-full bg-amber-100 flex items-center justify-center text-amber-600';
        if (iconEl) iconEl.className = 'fa-solid fa-triangle-exclamation text-2xl';
    }

    if (titleEl) titleEl.textContent = finalTitle;
    textEl.textContent = message;
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

// ── 11. Submit Appointment ───────────────────────────────────────────────────
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
        if (!response.ok) {
            throw new Error(result.message || 'Failed to complete booking.');
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
        showValidationModal(error.message, null, 'Booking Notice', 'warning');
        const submitOnlineBtn = document.getElementById('submitOnlineBookingBtn');
        if (submitOnlineBtn) {
            submitOnlineBtn.disabled = false;
            submitOnlineBtn.innerHTML = '<i class="fa-solid fa-check-circle"></i> Confirm &amp; Finalize Booking';
        }
    }
}