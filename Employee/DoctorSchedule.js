// ── DENTIST SCHEDULE & APPROVED CUSTOMER BOOKINGS CONTROLLER ─────────────
const API_BASE_URL = window.BACKEND_API_BASE_URL || '';

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

const DAYS_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

// State
let currentDoctor = null;
let allDoctorsList = [];
let weeklySchedules = [];
let allDoctorAppointments = [];
let filteredAppointments = [];

let activeTab = "today";
let currentSearch = "";
let currentDateFilter = "";

function authHeaders(json = false) {
    const token = localStorage.getItem('userToken');
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
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

function getTodaySqlDate() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// ── Notice Modal ──────────────────────────────────────────────────────────
function showNotice(message, { title = "Notice", type = "info" } = {}) {
    const modal = document.getElementById('noticeModal');
    if (!modal) { console.log(title + ': ' + message); return; }

    const iconWrap = document.getElementById('noticeIconWrap');
    const icon = document.getElementById('noticeIcon');
    const titleEl = document.getElementById('noticeTitle');
    const msgEl = document.getElementById('noticeMessage');

    const styles = {
        success: { wrap: 'bg-green-100 text-green-700', icon: 'fa-circle-check' },
        error:   { wrap: 'bg-red-100 text-red-600',     icon: 'fa-circle-exclamation' },
        info:    { wrap: 'bg-[#EAF0DD] text-[#556022]', icon: 'fa-circle-info' }
    };
    const s = styles[type] || styles.info;

    iconWrap.className = `w-10 h-10 rounded-full flex items-center justify-center text-lg shrink-0 ${s.wrap}`;
    icon.className = `fa-solid ${s.icon}`;
    titleEl.textContent = title;
    msgEl.textContent = message;

    modal.classList.remove('hidden');
}

function closeNoticeModal() {
    const modal = document.getElementById('noticeModal');
    if (modal) modal.classList.add('hidden');
}

// ── Initialization ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initEventListeners();
    initSocketEvents();
    loadInitialData();
});

function initSocketEvents() {
    if (typeof io !== 'function') return;
    const socket = io();

    socket.on('payment-confirmed', () => {
        loadDoctorAppointments();
    });

    socket.on('appointment-updated', () => {
        loadDoctorAppointments();
    });
}

function initEventListeners() {
    // Notice modal
    document.getElementById('noticeOkBtn')?.addEventListener('click', closeNoticeModal);
    document.getElementById('noticeModal')?.addEventListener('click', (e) => {
        if (e.target === document.getElementById('noticeModal')) closeNoticeModal();
    });

    // Dentist switcher dropdown
    document.getElementById('dentistSelect')?.addEventListener('change', (e) => {
        const selectedId = Number(e.target.value);
        const doc = allDoctorsList.find(d => Number(d.user_id) === selectedId);
        if (doc) {
            currentDoctor = doc;
            updateDoctorHeader(doc);
            loadDoctorSchedule(selectedId);
            loadDoctorAppointments(selectedId);
        }
    });

    // Toggle shift timecards collapse
    document.getElementById('toggleShiftViewBtn')?.addEventListener('click', () => {
        const grid = document.getElementById('weeklyShiftGrid');
        if (!grid) return;
        grid.classList.toggle('hidden');
    });

    // Filter tabs
    const tabBtns = document.querySelectorAll('.schedTabBtn');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => {
                b.classList.remove('active', 'bg-[#667733]', 'text-white');
                b.classList.add('bg-[#FDFCE9]', 'text-[#2A1001]');
            });
            btn.classList.add('active', 'bg-[#667733]', 'text-white');
            btn.classList.remove('bg-[#FDFCE9]', 'text-[#2A1001]');

            activeTab = btn.dataset.tab || 'today';
            applyFiltersAndRender();
        });
    });

    // Search input
    document.getElementById('patientSearchInput')?.addEventListener('input', (e) => {
        currentSearch = e.target.value.trim().toLowerCase();
        applyFiltersAndRender();
    });

    // Date picker filter
    const dateInput = document.getElementById('dateFilterInput');
    const clearDateBtn = document.getElementById('clearDateFilterBtn');

    if (dateInput) {
        dateInput.addEventListener('change', (e) => {
            currentDateFilter = e.target.value;
            if (clearDateBtn) clearDateBtn.classList.toggle('hidden', !currentDateFilter);
            applyFiltersAndRender();
        });
    }

    if (clearDateBtn) {
        clearDateBtn.addEventListener('click', () => {
            currentDateFilter = "";
            if (dateInput) dateInput.value = "";
            clearDateBtn.classList.add('hidden');
            applyFiltersAndRender();
        });
    }

    // Complete Treatment Modal
    document.getElementById('closeCompleteModal')?.addEventListener('click', closeCompleteModal);
    document.getElementById('cancelCompleteBtn')?.addEventListener('click', closeCompleteModal);
    document.getElementById('completeModal')?.addEventListener('click', (e) => {
        if (e.target === document.getElementById('completeModal')) closeCompleteModal();
    });
    document.getElementById('completeTreatmentForm')?.addEventListener('submit', handleCompleteTreatmentSubmit);

    // Receipt Modal
    document.getElementById('closeReceiptModal')?.addEventListener('click', closeReceiptModal);
    document.getElementById('closeReceiptBtn')?.addEventListener('click', closeReceiptModal);
    document.getElementById('receiptModal')?.addEventListener('click', (e) => {
        if (e.target === document.getElementById('receiptModal')) closeReceiptModal();
    });
    document.getElementById('printReceiptBtn')?.addEventListener('click', printCurrentReceipt);
}

// ── Load Initial Data ─────────────────────────────────────────────────────
async function loadInitialData() {
    try {
        // 1. Fetch current logged-in doctor profile
        const resDoctor = await fetch(`${API_BASE_URL}/api/doctor/my-profile`, { headers: authHeaders() });
        if (resDoctor.ok) {
            currentDoctor = await resDoctor.json();
        } else {
            const stored = localStorage.getItem('user');
            if (stored) currentDoctor = JSON.parse(stored);
            else currentDoctor = { user_id: 1, first_name: 'Attending', last_name: 'Dentist', position: 'Dentist' };
        }

        updateDoctorHeader(currentDoctor);

        // 2. Fetch all doctors list to populate selector (for Admin or multi-dentist clinics)
        const resAllDoctors = await fetch(`${API_BASE_URL}/api/doctors`, { headers: authHeaders() });
        if (resAllDoctors.ok) {
            allDoctorsList = await resAllDoctors.json();
            populateDentistSelector(allDoctorsList, currentDoctor);
        }

        const activeDoctorId = currentDoctor.user_id || 1;

        // 3. Load Doctor Schedule & Approved Bookings
        await Promise.all([
            loadDoctorSchedule(activeDoctorId),
            loadDoctorAppointments(activeDoctorId)
        ]);

    } catch (err) {
        console.error('Error loading initial dentist schedule data:', err);
    }
}

function updateDoctorHeader(doc) {
    const headerEl = document.getElementById('doctorProfileHeader');
    if (headerEl) {
        const staffCode = doc.public_id || doc.staff_code || `DOC-${doc.user_id}`;
        headerEl.innerHTML = `
            <span class="inline-flex items-center gap-1.5 font-extrabold text-[#667733]">
                <i class="fa-solid fa-user-doctor"></i> Dr. ${escapeHtml(doc.first_name)} ${escapeHtml(doc.last_name)}
            </span>
            <span class="text-gray-400 font-normal">&bull;</span>
            <span class="text-[#2A1001]/70 font-semibold">${escapeHtml(doc.position || 'Dentist')} (${escapeHtml(staffCode)})</span>
        `;
    }
}

function populateDentistSelector(doctors, activeDoc) {
    const wrapper = document.getElementById('dentistSelectorWrapper');
    const select = document.getElementById('dentistSelect');
    if (!wrapper || !select || doctors.length <= 1) return;

    wrapper.classList.remove('hidden');
    select.innerHTML = doctors.map(d => `
        <option value="${d.user_id}" ${d.user_id === activeDoc.user_id ? 'selected' : ''}>
            Dr. ${escapeHtml(d.first_name)} ${escapeHtml(d.last_name)}
        </option>
    `).join('');
}

// ── Load Doctor Shifts & Timecards ─────────────────────────────────────────
async function loadDoctorSchedule(doctorId) {
    try {
        const res = await fetch(`${API_BASE_URL}/api/doctor-schedule/${doctorId}/schedule`, { headers: authHeaders() });
        if (res.ok) {
            weeklySchedules = await res.json();
        } else {
            // Default shift preset (Mon-Sat on duty, Sun off)
            weeklySchedules = [1, 2, 3, 4, 5, 6].map(d => ({
                day_of_week: d,
                start_time: '08:00:00',
                end_time: '17:00:00',
                break_start: '12:00:00',
                break_end: '13:00:00',
                is_active: 1
            }));
            weeklySchedules.push({
                day_of_week: 0,
                start_time: '08:00:00',
                end_time: '17:00:00',
                break_start: '12:00:00',
                break_end: '13:00:00',
                is_active: 0
            });
        }

        renderWeeklyShiftGrid(weeklySchedules);
        updateTopStats(weeklySchedules);

    } catch (err) {
        console.error('Error fetching doctor schedules:', err);
    }
}

function renderWeeklyShiftGrid(schedules) {
    const container = document.getElementById('weeklyShiftGrid');
    if (!container) return;

    const daysOrder = [1, 2, 3, 4, 5, 6, 0]; // Mon to Sun

    container.innerHTML = daysOrder.map(dayIdx => {
        const sched = schedules.find(s => s.day_of_week === dayIdx) || {
            day_of_week: dayIdx,
            start_time: '08:00:00',
            end_time: '17:00:00',
            break_start: '12:00:00',
            break_end: '13:00:00',
            is_active: dayIdx !== 0 ? 1 : 0
        };

        const isActive = sched.is_active === 1 || sched.is_active === true;

        return `
            <div class="rounded-2xl p-4 border transition-all flex flex-col justify-between shadow-sm ${
            isActive ? 'bg-[#F9F8F3] border-[#2A1001]/15 hover:border-[#667733]' : 'bg-gray-100/70 border-gray-200 opacity-60'
        }">
                <div class="flex justify-between items-center pb-2 border-b border-[#2A1001]/10">
                    <h4 class="font-extrabold text-sm text-[#2A1001]">${DAYS_NAMES[dayIdx]}</h4>
                    <span class="text-[10px] font-black px-2 py-0.5 rounded-full ${
            isActive ? 'bg-[#D7E3A5] text-[#2c3e2b] border border-[#667733]/30' : 'bg-gray-200 text-gray-500'
        }">
                        ${isActive ? 'ON DUTY' : 'DAY OFF'}
                    </span>
                </div>

                <div class="my-2.5 flex flex-col gap-1 text-xs">
                    <div class="flex items-center justify-between">
                        <span class="font-semibold text-gray-500 text-[11px]">Duty Shift:</span>
                        <span class="font-bold text-[#2A1001]">${isActive ? `${format12Hour(sched.start_time)} – ${format12Hour(sched.end_time)}` : 'Closed'}</span>
                    </div>
                    <div class="flex items-center justify-between">
                        <span class="font-semibold text-gray-500 text-[11px]">Lunch Break:</span>
                        <span class="font-semibold text-gray-700">${isActive ? `${format12Hour(sched.break_start)} – ${format12Hour(sched.break_end)}` : 'None'}</span>
                    </div>
                </div>

                <div class="pt-1.5 border-t border-black/5 text-[10px] text-gray-500 font-medium flex items-center gap-1">
                    <i class="fa-solid fa-circle-check ${isActive ? 'text-green-600' : 'text-gray-400'}"></i>
                    <span>${isActive ? 'Available for online booking' : 'Off-duty day'}</span>
                </div>
            </div>
        `;
    }).join('');
}

function updateTopStats(schedules) {
    const today = new Date();
    const todayDayIdx = today.getDay();
    const todaySched = schedules.find(s => s.day_of_week === todayDayIdx);
    const isTodayOn = todaySched && (todaySched.is_active === 1 || todaySched.is_active === true);

    const shiftTextEl = document.getElementById('todayShiftText');
    const breakTextEl = document.getElementById('todayBreakText');
    const statusBadgeEl = document.getElementById('todayStatusBadge');
    const activeDaysEl = document.getElementById('activeDaysCountText');

    if (shiftTextEl) {
        if (isTodayOn) {
            shiftTextEl.textContent = `${format12Hour(todaySched.start_time)} – ${format12Hour(todaySched.end_time)}`;
            if (breakTextEl) breakTextEl.textContent = `Lunch: ${format12Hour(todaySched.break_start)} – ${format12Hour(todaySched.break_end)}`;
            if (statusBadgeEl) statusBadgeEl.innerHTML = '<span class="text-green-700 flex items-center gap-1"><i class="fa-solid fa-circle text-[8px] animate-pulse text-green-600"></i> On Duty Today</span>';
        } else {
            shiftTextEl.textContent = 'Day Off / Closed';
            if (breakTextEl) breakTextEl.textContent = 'No clinic shift scheduled';
            if (statusBadgeEl) statusBadgeEl.innerHTML = '<span class="text-gray-500">⚪ Off Duty Today</span>';
        }
    }

    const activeDaysCount = schedules.filter(s => s.is_active === 1 || s.is_active === true).length;
    if (activeDaysEl) {
        activeDaysEl.textContent = `${activeDaysCount} Days / Week`;
    }
}

// ── Load Approved Customer Bookings ────────────────────────────────────────
async function loadDoctorAppointments(doctorId) {
    const docId = doctorId || (currentDoctor ? currentDoctor.user_id : 1);

    try {
        const res = await fetch(`${API_BASE_URL}/api/doctors/${docId}/appointments`, { headers: authHeaders() });
        if (res.ok) {
            allDoctorAppointments = await res.json();
        } else {
            const resFallback = await fetch(`${API_BASE_URL}/api/doctor/my-appointments`, { headers: authHeaders() });
            allDoctorAppointments = resFallback.ok ? await resFallback.json() : [];
        }

        updateTabBadges();
        applyFiltersAndRender();

    } catch (err) {
        console.error('Error fetching doctor appointments:', err);
        allDoctorAppointments = [];
        applyFiltersAndRender();
    }
}

function updateTabBadges() {
    const todayStr = getTodaySqlDate();

    const todayCount = allDoctorAppointments.filter(a => {
        const aDate = (a.appointment_date || '').split('T')[0];
        return aDate === todayStr && a.appointment_status === 'approved';
    }).length;

    const futureCount = allDoctorAppointments.filter(a => {
        const aDate = (a.appointment_date || '').split('T')[0];
        return aDate > todayStr && a.appointment_status === 'approved';
    }).length;

    const tabTodayEl = document.getElementById('tabCountToday');
    if (tabTodayEl) tabTodayEl.textContent = todayCount;

    const tabFutureEl = document.getElementById('tabCountFuture');
    if (tabFutureEl) tabFutureEl.textContent = futureCount;

    const todayStatsEl = document.getElementById('todayApptCountText');
    if (todayStatsEl) {
        todayStatsEl.textContent = `${todayCount} Booked`;
    }

    const futureStatsEl = document.getElementById('futureApptCountText');
    if (futureStatsEl) {
        futureStatsEl.textContent = `${futureCount} Upcoming`;
    }
}

// ── Filter & Render Patient Bookings Schedule ──────────────────────────────
function applyFiltersAndRender() {
    const todayStr = getTodaySqlDate();

    filteredAppointments = allDoctorAppointments.filter(appt => {
        const apptDate = (appt.appointment_date || '').split('T')[0];
        const status = (appt.appointment_status || '').toLowerCase();

        // 1. Tab Filter: 'today' vs 'future' (defaulting to today if unknown)
        let matchesTab = false;
        if (activeTab === 'future' || activeTab === 'upcoming') {
            matchesTab = apptDate > todayStr && status === 'approved';
        } else {
            // Default: today
            matchesTab = apptDate === todayStr && status === 'approved';
        }

        // 2. Specific Date Filter (if selected by user)
        let matchesDate = true;
        if (currentDateFilter) {
            matchesDate = apptDate === currentDateFilter;
        }

        // 3. Search Filter
        const patientName = `${appt.patient_first_name || ''} ${appt.patient_last_name || ''} ${appt.patient_name || ''}`.toLowerCase();
        const service = (appt.service_label || appt.primary_service || appt.services || '').toLowerCase();
        const pubId = String(appt.patient_public_id || appt.public_id || appt.appointment_id || '').toLowerCase();
        const phone = String(appt.patient_phone || '').toLowerCase();

        const matchesSearch = !currentSearch ||
            patientName.includes(currentSearch) ||
            service.includes(currentSearch) ||
            pubId.includes(currentSearch) ||
            phone.includes(currentSearch);

        return matchesTab && matchesDate && matchesSearch;
    });

    renderPatientAppointments();
}

function renderPatientAppointments() {
    const container = document.getElementById('patientAppointmentsContainer');
    const emptyState = document.getElementById('noAppointmentsState');
    if (!container) return;

    container.innerHTML = '';

    if (filteredAppointments.length === 0) {
        if (emptyState) emptyState.classList.remove('hidden');
        return;
    } else {
        if (emptyState) emptyState.classList.add('hidden');
    }

    filteredAppointments.forEach(appt => {
        const card = document.createElement('div');
        card.className = "bg-white rounded-2xl p-4 sm:p-5 border border-[#2A1001]/15 shadow-sm hover:shadow-md transition-all flex flex-col lg:flex-row lg:items-center justify-between gap-4";

        const scheduledDate = appt.appointment_date
            ? new Date(appt.appointment_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : 'N/A';

        const patientFullName = (appt.patient_first_name || appt.patient_last_name)
            ? `${appt.patient_first_name || ''} ${appt.patient_last_name || ''}`.trim()
            : (appt.patient_name || 'Patient');

        const serviceTitle = escapeHtml(appt.service_label || appt.primary_service || appt.services || 'General Dental Treatment');
        const rawAmount = Number(appt.amount || appt.service_price || appt.total_amount || 0);
        const amountFormatted = `₱${rawAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

        const payStatus = (appt.payment_status || 'unpaid').toLowerCase();
        const payMethod = (appt.payment_method || 'cash').toLowerCase();

        let paymentBadge = '';
        if (payStatus === 'paid') {
            paymentBadge = `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-extrabold bg-[#D7E3A5] text-[#1a281b] border border-[#667733]/30"><i class="fa-solid fa-circle-check mr-1 text-green-700"></i>PAID (${payMethod.toUpperCase()})</span>`;
        } else if (payStatus === 'refunded') {
            paymentBadge = `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-extrabold bg-blue-100 text-blue-800 border border-blue-300">REFUNDED</span>`;
        } else {
            paymentBadge = `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-extrabold bg-gray-100 text-gray-700 border border-gray-300"><i class="fa-solid fa-coins mr-1 text-amber-600"></i>CASH IN CLINIC (UNPAID)</span>`;
        }

        const isCompleted = (appt.appointment_status || '').toLowerCase() === 'completed';

        card.innerHTML = `
            <!-- Left Info Block -->
            <div class="flex-1 min-w-0 flex flex-col gap-1.5">
                <div class="flex flex-wrap items-center gap-2">
                    <span class="font-extrabold text-sm sm:text-base text-[#667733] font-mono flex items-center gap-1.5">
                        <i class="fa-regular fa-clock"></i> ${format12Hour(appt.time_slot)}
                    </span>
                    <span class="text-xs text-[#2A1001]/60 font-bold">&bull; ${scheduledDate}</span>
                    <span class="text-[10px] bg-gray-100 text-gray-700 font-bold px-2 py-0.5 rounded-full">${appt.duration_minutes || 60} mins</span>
                    ${paymentBadge}
                    ${isCompleted ? '<span class="text-[10px] bg-green-100 text-green-800 font-extrabold px-2.5 py-0.5 rounded-full border border-green-300"><i class="fa-solid fa-check mr-1"></i>COMPLETED</span>' : ''}
                </div>

                <div class="flex flex-wrap items-center gap-2">
                    <h3 class="font-black text-base sm:text-lg text-[#2A1001] font-['Poppins']">
                        ${escapeHtml(patientFullName)}
                    </h3>
                    <span class="text-xs text-[#2A1001]/60 font-semibold">(${escapeHtml(appt.patient_public_id || `ID: ${appt.patient_id || appt.appointment_id}`)})</span>
                    ${appt.patient_phone ? `<span class="text-xs text-gray-600 font-bold"><i class="fa-solid fa-phone text-[10px] text-gray-400 ml-1"></i> ${escapeHtml(appt.patient_phone)}</span>` : ''}
                </div>

                <div class="text-xs font-semibold text-[#2A1001]/80">
                    <span class="font-extrabold text-[#667733]">${serviceTitle}</span> &bull; ${amountFormatted}
                </div>

                ${appt.patient_note ? `
                    <div class="text-xs text-gray-600 bg-gray-50 px-3 py-1.5 rounded-xl border border-black/5 mt-0.5 flex items-start gap-1.5">
                        <i class="fa-regular fa-comment-dots text-gray-400 mt-0.5"></i>
                        <span><strong>Patient Concern:</strong> "${escapeHtml(appt.patient_note)}"</span>
                    </div>
                ` : ''}

                ${appt.dentist_note ? `
                    <div class="text-xs text-green-900 bg-green-50/70 px-3 py-1.5 rounded-xl border border-green-200 mt-0.5 flex items-start gap-1.5">
                        <i class="fa-solid fa-notes-medical text-green-700 mt-0.5"></i>
                        <span><strong>Dentist Remarks:</strong> "${escapeHtml(appt.dentist_note)}"</span>
                    </div>
                ` : ''}
            </div>

            <!-- Right Action Buttons (Doctor Actions: Mark as Completed & Receipt) -->
            <div class="flex items-center gap-2 flex-wrap sm:flex-nowrap shrink-0 justify-end pt-2 lg:pt-0 border-t lg:border-t-0 border-[#2A1001]/10">
                ${!isCompleted ? `
                    <button onclick="openCompleteModal(${appt.appointment_id})"
                            class="bg-[#667733] hover:bg-[#556022] text-white text-xs font-bold px-4 py-2 rounded-full transition shadow-sm cursor-pointer active:scale-95 flex items-center gap-1.5 whitespace-nowrap">
                        <i class="fa-solid fa-circle-check text-xs"></i> Mark as Completed
                    </button>
                ` : ''}

                <button onclick="openReceiptModalById(${appt.appointment_id})"
                        class="bg-white hover:bg-gray-100 text-[#2A1001] border border-[#2A1001]/20 text-xs font-bold px-3.5 py-2 rounded-full transition shadow-sm cursor-pointer active:scale-95 flex items-center gap-1.5 whitespace-nowrap">
                    <i class="fa-solid fa-receipt text-xs"></i> Receipt &amp; Details
                </button>
            </div>
        `;

        container.appendChild(card);
    });
}

// ── Complete Treatment Modal Logic ────────────────────────────────────────
function openCompleteModal(appointmentId) {
    const appt = allDoctorAppointments.find(a => a.appointment_id == appointmentId);
    if (!appt) return;

    document.getElementById('completeAppointmentId').value = appointmentId;
    document.getElementById('dentistNotesText').value = appt.dentist_note || '';

    const patientFullName = (appt.patient_first_name || appt.patient_last_name)
        ? `${appt.patient_first_name || ''} ${appt.patient_last_name || ''}`.trim()
        : (appt.patient_name || 'Patient');

    document.getElementById('completeModalPatientSummary').textContent =
        `Patient: ${patientFullName} • Treatment: ${appt.service_label || appt.primary_service || 'Service'}`;

    document.getElementById('completeModal').classList.remove('hidden');
}

function closeCompleteModal() {
    document.getElementById('completeModal')?.classList.add('hidden');
}

async function handleCompleteTreatmentSubmit(e) {
    e.preventDefault();
    const appointmentId = document.getElementById('completeAppointmentId').value;
    const notes = document.getElementById('dentistNotesText').value.trim();
    const saveBtn = document.getElementById('saveCompleteBtn');

    if (!notes) {
        showNotice('Please write a brief clinical note or instruction before completing the treatment.', { title: 'Remarks Required', type: 'error' });
        return;
    }

    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
    }

    try {
        const res = await fetch(`${API_BASE_URL}/api/doctor-schedule/appointments/${appointmentId}/complete`, {
            method: 'PATCH',
            headers: authHeaders(true),
            body: JSON.stringify({ dentist_note: notes })
        });

        if (res.ok) {
            closeCompleteModal();
            showNotice('Treatment has been marked as completed. The patient has been notified and notes have been recorded.', { title: 'Treatment Completed', type: 'success' });
            await loadDoctorAppointments();
        } else {
            const err = await res.json().catch(() => ({}));
            showNotice(err.message || 'Failed to complete appointment.', { title: 'Error', type: 'error' });
        }
    } catch (err) {
        console.error('Error completing treatment:', err);
        showNotice('Failed to connect to server.', { title: 'Error', type: 'error' });
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fa-solid fa-check-double"></i> Mark Treatment as Completed';
        }
    }
}

// ── Official Receipt & Details Modal Logic ─────────────────────────────────
let selectedReceiptAppt = null;

function openReceiptModalById(appointmentId) {
    const appt = allDoctorAppointments.find(a => a.appointment_id == appointmentId);
    if (!appt) return;
    selectedReceiptAppt = appt;

    const scheduledDate = appt.appointment_date
        ? new Date(appt.appointment_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
        : 'N/A';

    const patientFullName = (appt.patient_first_name || appt.patient_last_name)
        ? `${appt.patient_first_name || ''} ${appt.patient_last_name || ''}`.trim()
        : (appt.patient_name || 'Valued Patient');

    const rawAmount = Number(appt.amount || appt.service_price || appt.total_amount || 0);
    const amountFormatted = `₱${rawAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    const receiptNo = `OR-${(appt.appointment_date || '').replace(/-/g, '')}-${appt.appointment_id}`;
    const status = (appt.appointment_status || '').toUpperCase();
    const payStatus = (appt.payment_status || 'Unpaid').toUpperCase();
    const method = (appt.payment_method || 'Cash in Clinic').toUpperCase();

    const dentistFullName = currentDoctor
        ? `Dr. ${currentDoctor.first_name} ${currentDoctor.last_name}`
        : 'Assigned Dentist';

    document.getElementById('receiptModalBody').innerHTML = `
        <div class="flex flex-col sm:flex-row justify-between sm:items-center pb-3 border-b border-dashed border-[#2A1001]/20 gap-2">
            <div>
                <span class="text-[10px] text-[#2A1001]/60 uppercase tracking-wider font-bold">Official Statement / Receipt No.</span>
                <p class="font-extrabold text-sm sm:text-base text-[#2A1001] font-mono">${escapeHtml(receiptNo)}</p>
            </div>
            <div class="sm:text-right">
                <span class="text-[10px] text-[#2A1001]/60 uppercase tracking-wider font-bold block mb-1">Status</span>
                <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold ${status === 'COMPLETED' ? 'bg-[#c2d09c] text-[#1a281b]' : 'bg-[#9ea988] text-[#1a281b]'}">${escapeHtml(status)}</span>
            </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 py-1">
            <div>
                <span class="text-[11px] text-[#2A1001]/60 font-semibold block uppercase tracking-wide">Patient Name</span>
                <span class="font-bold text-sm text-[#2A1001]">${escapeHtml(patientFullName)} (${escapeHtml(appt.patient_public_id || `PAT-${appt.patient_id}`)})</span>
            </div>
            <div>
                <span class="text-[11px] text-[#2A1001]/60 font-semibold block uppercase tracking-wide">Attending Dentist</span>
                <span class="font-bold text-sm text-[#667733]"><i class="fa-solid fa-user-doctor mr-1"></i> ${escapeHtml(dentistFullName)}</span>
            </div>
            <div>
                <span class="text-[11px] text-[#2A1001]/60 font-semibold block uppercase tracking-wide">Scheduled Schedule</span>
                <span class="font-bold text-sm text-[#2A1001]">${scheduledDate} &bull; ${format12Hour(appt.time_slot)}</span>
            </div>
            <div>
                <span class="text-[11px] text-[#2A1001]/60 font-semibold block uppercase tracking-wide">Payment Status / Mode</span>
                <span class="font-bold text-sm text-[#2A1001]">${escapeHtml(payStatus)} &bull; ${escapeHtml(method)}</span>
            </div>
        </div>

        <div class="mt-2 pt-3 border-t border-[#2A1001]/10">
            <table class="w-full text-xs sm:text-sm">
                <thead>
                    <tr class="text-[#2A1001]/70 border-b border-[#2A1001]/10 uppercase text-[10px] tracking-wider">
                        <th class="text-left py-2 font-extrabold">Service / Treatment Description</th>
                        <th class="text-right py-2 font-extrabold">Amount (PHP)</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td class="py-2.5">
                            <p class="font-bold text-[#2A1001] text-sm">${escapeHtml(appt.service_label || appt.primary_service || 'Treatment')}</p>
                            <p class="text-xs text-[#2A1001]/60">${escapeHtml(appt.patient_note || 'Standard dental clinic service & consultation')}</p>
                        </td>
                        <td class="text-right py-2.5 font-extrabold text-[#2A1001] text-sm">${amountFormatted}</td>
                    </tr>
                </tbody>
                <tfoot>
                    <tr class="border-t-2 border-[#2A1001]/20 font-black text-sm sm:text-base">
                        <td class="pt-3 text-[#2A1001]">Total Amount Due / Paid:</td>
                        <td class="pt-3 text-right text-[#667733]">${amountFormatted}</td>
                    </tr>
                </tfoot>
            </table>
        </div>

        ${appt.dentist_note ? `
            <div class="p-3 bg-green-50 rounded-xl border border-green-200 text-xs text-green-900 shadow-inner">
                <span class="font-bold block mb-1">Dentist Clinical Notes &amp; Treatment Summary:</span>
                <p class="italic">${escapeHtml(appt.dentist_note)}</p>
            </div>
        ` : ''}
    `;

    document.getElementById('receiptModal').classList.remove('hidden');
}

function closeReceiptModal() {
    document.getElementById('receiptModal')?.classList.add('hidden');
    selectedReceiptAppt = null;
}

function printCurrentReceipt() {
    if (!selectedReceiptAppt) return;
    const a = selectedReceiptAppt;
    const formattedAmount = `₱${Number(a.amount || a.service_price || a.total_amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    const receiptNo = `OR-${(a.appointment_date || '').replace(/-/g, '')}-${a.appointment_id}`;
    const patientName = `${a.patient_first_name || ''} ${a.patient_last_name || ''}`.trim() || a.patient_name || 'Valued Patient';
    const dentistName = currentDoctor ? `Dr. ${currentDoctor.first_name} ${currentDoctor.last_name}` : 'Clinic Dentist';

    const printHtml = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>Official Receipt - ${escapeHtml(receiptNo)}</title>
        <style>
            @page { margin: 15mm; }
            body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #2A1001; font-size: 13px; line-height: 1.5; padding: 20px; }
            .header { text-align: center; margin-bottom: 25px; border-bottom: 2px solid #667733; padding-bottom: 12px; }
            .header h1 { margin: 0; font-size: 22px; color: #2A1001; }
            .header p { margin: 2px 0; color: #666; font-size: 12px; }
            .info-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; margin-top: 15px; }
            .info-table th { background: #667733; color: white; text-align: left; padding: 8px; font-size: 12px; }
            .info-table td { padding: 10px 8px; border-bottom: 1px solid #ddd; }
            .total-row { font-weight: bold; font-size: 15px; }
            .footer { margin-top: 40px; text-align: center; font-size: 11px; color: #888; border-top: 1px solid #ccc; padding-top: 10px; }
        </style>
    </head>
    <body>
        <div class="header">
            <h1>DENTAL CLINIC INC.</h1>
            <p>Official Patient Appointment Receipt &amp; Statement of Service</p>
            <p>Printed on: ${new Date().toLocaleDateString()}</p>
        </div>
        <table style="width: 100%; margin-bottom: 20px;">
            <tr>
                <td><strong>Receipt No:</strong> ${escapeHtml(receiptNo)}</td>
                <td style="text-align: right;"><strong>Date:</strong> ${escapeHtml(a.appointment_date)}</td>
            </tr>
            <tr>
                <td><strong>Patient:</strong> ${escapeHtml(patientName)} (${escapeHtml(a.patient_public_id || `PAT-${a.appointment_id}`)})</td>
                <td style="text-align: right;"><strong>Status:</strong> ${escapeHtml(a.appointment_status).toUpperCase()}</td>
            </tr>
            <tr>
                <td><strong>Attending Dentist:</strong> ${escapeHtml(dentistName)}</td>
                <td style="text-align: right;"><strong>Time Slot:</strong> ${escapeHtml(a.time_slot || 'N/A')}</td>
            </tr>
            <tr>
                <td><strong>Payment Mode:</strong> ${escapeHtml((a.payment_method || 'Cash').toUpperCase())}</td>
                <td style="text-align: right;"><strong>Payment Status:</strong> ${escapeHtml((a.payment_status || 'Unpaid').toUpperCase())}</td>
            </tr>
        </table>

        <table class="info-table">
            <thead>
                <tr>
                    <th>Service / Treatment Description</th>
                    <th style="text-align: right;">Amount (PHP)</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>
                        <strong>${escapeHtml(a.service_label || a.primary_service || 'General Treatment')}</strong><br>
                        <span style="font-size: 11px; color: #666;">${escapeHtml(a.patient_note || 'Standard consultation & treatment')}</span>
                    </td>
                    <td style="text-align: right; font-weight: bold;">${formattedAmount}</td>
                </tr>
                <tr class="total-row">
                    <td style="text-align: right; padding-top: 15px;">Total Amount Due / Paid:</td>
                    <td style="text-align: right; padding-top: 15px; color: #667733;">${formattedAmount}</td>
                </tr>
            </tbody>
        </table>

        ${a.dentist_note ? `
            <div style="margin-top: 15px; padding: 10px; border: 1px dashed #aaa; border-radius: 6px; font-size: 11px;">
                <strong>Dentist Clinical Notes:</strong> ${escapeHtml(a.dentist_note)}
            </div>
        ` : ''}

        <div class="footer">
            <p>Thank you for choosing our dental clinic for your oral healthcare!</p>
            <p>This document serves as an electronic official receipt statement.</p>
        </div>
    </body>
    </html>`;

    document.getElementById('printReceiptFrame')?.remove();
    const frame = document.createElement('iframe');
    frame.id = 'printReceiptFrame';
    frame.style.cssText = 'position:fixed; right:0; bottom:0; width:0; height:0; border:0;';
    frame.onload = () => {
        frame.contentWindow.focus();
        frame.contentWindow.print();
    };
    frame.srcdoc = printHtml;
    document.body.appendChild(frame);
}