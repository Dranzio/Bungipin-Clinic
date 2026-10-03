// ── PATIENT APPOINTMENT HISTORY & RECEIPTS CONTROLLER ──────────────────────
const TEST_MODE = false;
const MAX_RESCHEDULE_LIMIT = 2; // Maximum allowed reschedules

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

let allAppointments = [];
let filteredAppointments = [];

let currentSearch = "";
let currentStatus = "all";
let currentSort = "recent";
let currentPage = 1;
const rowsPerPage = 8;

let currentSelectedAppt = null;
let appointmentToCancelId = null;

// ── Reschedule state ─────────────────────────────────────────────────────
const months = [
    'January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'
];

let pendingRescheduleAppt = null;
let reschedCurrentDate = new Date();
const reschedToday = new Date();
let reschedSelectedDate = null;
let reschedSelectedDateFormatted = null;
let reschedSelectedTime = null;
let reschedSelectedEndTime = null;

const RESCHEDULABLE_STATUSES = ['pending', 'approved'];
const CANCELLABLE_STATUSES = ['pending', 'approved'];

document.addEventListener('DOMContentLoaded', () => {
    initEventListeners();
    fetchAppointments();
    initPaymentSocket();
    initReasonRadioListeners();
});

function formatTime12h(timeStr) {
    if (!timeStr) return "";
    const [hStr, mStr] = String(timeStr).split(":");
    let h = parseInt(hStr, 10);
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${mStr || '00'} ${ampm}`;
}

function getServiceDuration(serviceLabel) {
    const l = String(serviceLabel || '').toLowerCase();
    if (l.includes('root') || l.includes('canal')) return 90;
    if (l.includes('whiten')) return 60;
    if (l.includes('clean') || l.includes('prophylaxis')) return 45;
    if (l.includes('pasta') || l.includes('filling')) return 30;
    return 30;
}

function calculateApptDuration(appt) {
    if (!appt) return 30;
    if (appt.time_slot && appt.end_time_slot && appt.end_time_slot !== '00:00:00') {
        const [sh, sm] = String(appt.time_slot).split(':').map(Number);
        const [eh, em] = String(appt.end_time_slot).split(':').map(Number);
        const diff = (eh * 60 + em) - (sh * 60 + sm);
        if (diff > 0) return diff;
    }
    return getServiceDuration(appt.label);
}

function getFormattedTimeRange(timeSlot, endTimeSlot, serviceLabel) {
    if (!timeSlot) return "N/A";
    
    if (endTimeSlot && endTimeSlot !== '00:00:00' && endTimeSlot !== timeSlot) {
        return `${formatTime12h(timeSlot)} – ${formatTime12h(endTimeSlot)}`;
    }

    const [hStr, mStr] = String(timeSlot).split(":");
    const startMins = parseInt(hStr, 10) * 60 + parseInt(mStr || "0", 10);
    const duration = getServiceDuration(serviceLabel);

    const endMins = startMins + duration;
    const endH = Math.floor(endMins / 60);
    const endM = endMins % 60;
    const fallbackEnd = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00`;

    return `${formatTime12h(timeSlot)} – ${formatTime12h(fallbackEnd)}`;
}

// ── Notice modal ────────────────────────────────────────────────────────────
function showNotice(message, { title = "Notice", type = "info" } = {}) {
    const modal = document.getElementById('notice-modal');
    if (!modal) return;

    const iconWrap = document.getElementById('notice-icon-wrap');
    const icon = document.getElementById('notice-icon');
    const titleEl = document.getElementById('notice-title');
    const msgEl = document.getElementById('notice-message');

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
    const modal = document.getElementById('notice-modal');
    if (modal) modal.classList.add('hidden');
}

function initReasonRadioListeners() {
    const reschedRadios = document.querySelectorAll('input[name="reschedReasonRadio"]');
    const customReschedContainer = document.getElementById('customReasonContainer');
    const customReschedText = document.getElementById('customReasonText');
    const customReschedCount = document.getElementById('customReasonCount');

    reschedRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (e.target.value === 'other') {
                customReschedContainer?.classList.remove('hidden');
                customReschedText?.focus();
            } else {
                customReschedContainer?.classList.add('hidden');
            }
            updateReschedSummaryDisplay();
        });
    });

    if (customReschedText) {
        customReschedText.addEventListener('input', () => {
            if (customReschedCount) customReschedCount.textContent = customReschedText.value.length;
            updateReschedSummaryDisplay();
        });
    }

    const cancelRadios = document.querySelectorAll('input[name="cancelReasonRadio"]');
    const customCancelContainer = document.getElementById('customCancelReasonContainer');
    const customCancelText = document.getElementById('customCancelReasonText');
    const customCancelCount = document.getElementById('customCancelReasonCount');
    const cancelError = document.getElementById('cancelReasonError');

    cancelRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (cancelError) cancelError.classList.add('hidden');
            if (e.target.value === 'other') {
                customCancelContainer?.classList.remove('hidden');
                customCancelText?.focus();
            } else {
                customCancelContainer?.classList.add('hidden');
            }
        });
    });

    if (customCancelText && customCancelCount) {
        customCancelText.addEventListener('input', () => {
            if (cancelError) cancelError.classList.add('hidden');
            customCancelCount.textContent = customCancelText.value.length;
        });
    }
}

function initPaymentSocket() {
    if (typeof io !== 'function') return;
    const socket = io();

    socket.on('payment-confirmed', (data) => {
        const affectedId = data && data.appointment_id;
        fetchAppointments().then(() => {
            if (currentSelectedAppt && affectedId && Number(currentSelectedAppt.appointment_id) === Number(affectedId)) {
                const updated = allAppointments.find(a => Number(a.appointment_id) === Number(affectedId));
                if (updated) openDetailModal(updated);
            }
        });
    });

    socket.on('appointment-updated', () => {
        fetchAppointments();
    });
}

function initEventListeners() {
    const searchInput = document.getElementById('searchInput');
    const statusFilter = document.getElementById('statusFilter');
    const sortSelect = document.getElementById('sortSelect');

    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            currentSearch = e.target.value.trim();
            currentPage = 1;
            applyFiltersAndRender();
        });
    }

    if (statusFilter) {
        statusFilter.addEventListener('change', (e) => {
            currentStatus = e.target.value;
            currentPage = 1;
            applyFiltersAndRender();
        });
    }

    if (sortSelect) {
        sortSelect.addEventListener('change', (e) => {
            currentSort = e.target.value;
            currentPage = 1;
            applyFiltersAndRender();
        });
    }

    const detailModal = document.getElementById('detail-modal');
    if (detailModal) {
        detailModal.addEventListener('click', (e) => {
            if (e.target === detailModal) closeDetailModal();
        });
    }

    const cancelModal = document.getElementById('cancel-modal');
    if (cancelModal) {
        cancelModal.addEventListener('click', (e) => {
            if (e.target === cancelModal) closeCancelModal();
        });
    }

    const noticeModal = document.getElementById('notice-modal');
    if (noticeModal) {
        noticeModal.addEventListener('click', (e) => {
            if (e.target === noticeModal) closeNoticeModal();
        });
    }
    const noticeOkBtn = document.getElementById('notice-ok-btn');
    if (noticeOkBtn) noticeOkBtn.addEventListener('click', closeNoticeModal);

    const reschedModal = document.getElementById('reschedule-modal');
    if (reschedModal) {
        reschedModal.addEventListener('click', (e) => {
            if (e.target === reschedModal) closeRescheduleModal();
        });
    }
    const closeReschedBtn = document.getElementById('closeRescheduleModalBtn');
    if (closeReschedBtn) closeReschedBtn.addEventListener('click', closeRescheduleModal);

    const cancelReschedBtn = document.getElementById('cancelRescheduleBtn');
    if (cancelReschedBtn) cancelReschedBtn.addEventListener('click', closeRescheduleModal);

    const reschedPrev = document.getElementById('reschedPrev');
    if (reschedPrev) reschedPrev.addEventListener('click', () => {
        reschedCurrentDate.setMonth(reschedCurrentDate.getMonth() - 1);
        renderReschedCalendar(reschedCurrentDate);
    });

    const reschedNext = document.getElementById('reschedNext');
    if (reschedNext) reschedNext.addEventListener('click', () => {
        reschedCurrentDate.setMonth(reschedCurrentDate.getMonth() + 1);
        renderReschedCalendar(reschedCurrentDate);
    });

    const confirmReschedBtn = document.getElementById('confirmRescheduleBtn');
    if (confirmReschedBtn) confirmReschedBtn.addEventListener('click', confirmReschedule);
}

async function fetchAppointments() {
    const tbody = document.getElementById('tableBody');
    const token = localStorage.getItem('userToken');

    if (!token && !TEST_MODE) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="text-center text-gray-500 py-10 font-bold">Please log in to view your appointments.</td></tr>`;
        return;
    }

    try {
        const response = await fetch('/api/appointments/mine', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.ok) {
            allAppointments = await response.json();
            populateDateSortOptions();
            applyFiltersAndRender();
        } else {
            console.error("Failed to load appointments:", response.status);
            if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="text-center text-red-500 py-10 font-bold">Failed to load appointments from server.</td></tr>`;
        }
    } catch(err) {
        console.error("Network error:", err);
        if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="text-center text-red-500 py-10 font-bold">Error connecting to server.</td></tr>`;
    }
}

function populateDateSortOptions() {
    const sortSelect = document.getElementById('sortSelect');
    if (!sortSelect) return;

    const groups = new Set();
    allAppointments.forEach(a => {
        if (!a.appointment_date) return;
        const date = new Date(a.appointment_date);
        if (isNaN(date)) return;
        const year = date.getFullYear();
        const month = date.toLocaleString('default', { month: 'long' });
        groups.add(`${year}-${date.getMonth()}::${month} ${year}`);
    });

    sortSelect.innerHTML = `
        <option value="recent" class="bg-white text-[#2A1001]">Sort: Newest First</option>
        <option value="oldest" class="bg-white text-[#2A1001]">Sort: Oldest First</option>
    `;

    Array.from(groups)
        .map(g => {
            const [sortKey, label] = g.split('::');
            return { sortKey, label };
        })
        .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
        .forEach(g => {
            const opt = document.createElement('option');
            opt.value = g.sortKey;
            opt.className = "bg-white text-[#2A1001]";
            opt.textContent = `Month: ${g.label}`;
            sortSelect.appendChild(opt);
        });
}

function applyFiltersAndRender() {
    filteredAppointments = allAppointments.filter(a => {
        const term = currentSearch.toLowerCase();
        const label = (a.label || '').toLowerCase();
        const refId = String(a.public_id || a.appointment_id || '').toLowerCase();
        const dentist = `${a.dentist_first_name || ''} ${a.dentist_last_name || ''}`.toLowerCase();

        const matchesSearch = !term || label.includes(term) || refId.includes(term) || dentist.includes(term);
        const status = (a.appointment_status || '').toLowerCase();
        const reschedStatus = (a.reschedule_status || '').toLowerCase();

        let matchesStatus = false;
        if (currentStatus === 'all') {
            matchesStatus = true;
        } else if (currentStatus === 'reschedule_requested') {
            matchesStatus = reschedStatus === 'requested';
        } else {
            matchesStatus = status === currentStatus;
        }

        return matchesSearch && matchesStatus;
    });

    if (currentSort === "recent") {
        filteredAppointments.sort((a, b) => {
            const timeB = b.created_at ? new Date(b.created_at).getTime() : new Date(`${b.appointment_date}T${b.time_slot || '00:00:00'}`).getTime();
            const timeA = a.created_at ? new Date(a.created_at).getTime() : new Date(`${a.appointment_date}T${a.time_slot || '00:00:00'}`).getTime();
            return timeB - timeA;
        });
    } else if (currentSort === "oldest") {
        filteredAppointments.sort((a, b) => {
            const timeA = a.created_at ? new Date(a.created_at).getTime() : new Date(`${a.appointment_date}T${a.time_slot || '00:00:00'}`).getTime();
            const timeB = b.created_at ? new Date(b.created_at).getTime() : new Date(`${b.appointment_date}T${b.time_slot || '00:00:00'}`).getTime();
            return timeA - timeB;
        });
    } else if (currentSort.includes('-')) {
        const [year, monthIndex] = currentSort.split('-').map(Number);
        filteredAppointments = filteredAppointments.filter(a => {
            const d = new Date(a.appointment_date);
            return d.getFullYear() === year && d.getMonth() === monthIndex;
        });
        filteredAppointments.sort((a, b) => {
            const timeB = b.created_at ? new Date(b.created_at).getTime() : new Date(`${b.appointment_date}T${b.time_slot || '00:00:00'}`).getTime();
            const timeA = a.created_at ? new Date(a.created_at).getTime() : new Date(`${a.appointment_date}T${a.time_slot || '00:00:00'}`).getTime();
            return timeB - timeA;
        });
    }

    renderTable();
}
function renderTable() {
    const tbody = document.getElementById('tableBody');
    const emptyState = document.getElementById('emptyState');
    if (!tbody) return;

    tbody.innerHTML = '';

    const start = (currentPage - 1) * rowsPerPage;
    const pageItems = filteredAppointments.slice(start, start + rowsPerPage);

    if (pageItems.length === 0) {
        if (emptyState) emptyState.classList.remove('hidden');
    } else {
        if (emptyState) emptyState.classList.add('hidden');
    }

    pageItems.forEach(appt => {
        const row = document.createElement('tr');
        row.className = "hover:bg-[#FDFCE9]/60 transition-colors border-b border-[#2A1001]/10";

        const scheduledDate = appt.appointment_date
            ? new Date(appt.appointment_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : 'N/A';

        const amountFormatted = appt.amount ? `₱${Number(appt.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '₱0.00';
        const status = (appt.appointment_status || '').toLowerCase();
        const paymentStatus = (appt.payment_status || '').toLowerCase();
        const reschedStatus = (appt.reschedule_status || '').toLowerCase();
        const reschedCount = Number(appt.reschedule_count || 0);

        const isCancellable = CANCELLABLE_STATUSES.includes(status);
        const isReschedulable = RESCHEDULABLE_STATUSES.includes(status);
        const hasReachedLimit = reschedCount >= MAX_RESCHEDULE_LIMIT && reschedStatus !== 'requested';
        const isReschedPending = reschedStatus === 'requested' && status !== 'cancelled' && status !== 'completed';

        // 👨‍⚕️ Attending Dentist Column
        let dentistColumnHtml = '';
        const dentistFullName = (appt.dentist_first_name || appt.dentist_last_name)
            ? `Dr. ${appt.dentist_first_name || ''} ${appt.dentist_last_name || ''}`.trim()
            : null;

        if (dentistFullName) {
            dentistColumnHtml = `
                <div class="font-extrabold text-[#2A1001] flex items-center gap-1.5">
                    <i class="fa-solid fa-user-doctor text-[#667733]"></i>
                    <span class="truncate">${escapeHtml(dentistFullName)}</span>
                </div>
            `;
        } else if (status === 'pending') {
            dentistColumnHtml = `
                <span class="inline-flex items-center gap-1 text-[11px] font-bold text-amber-800 bg-amber-50 px-2.5 py-1 rounded-full border border-amber-200">
                    <i class="fa-regular fa-clock text-amber-600"></i> Any Available Dentist
                </span>
            `;
        } else if (status === 'cancelled') {
            dentistColumnHtml = `<span class="text-xs text-gray-400 font-semibold">None (Cancelled)</span>`;
        } else {
            dentistColumnHtml = `<span class="text-xs text-gray-400">&mdash;</span>`;
        }

        // 🔄 Reschedule & Cancel Action Buttons (Aligned)
        let reschedActionHtml = '';
        if (isReschedulable) {
            if (hasReachedLimit) {
                reschedActionHtml = `
                    <button disabled
                            class="h-8 bg-gray-200 text-gray-400 text-xs font-bold px-3 rounded-full cursor-not-allowed opacity-75 shadow-none inline-flex items-center justify-center gap-1 shrink-0 whitespace-nowrap" 
                            title="Reschedule limit reached (Max ${MAX_RESCHEDULE_LIMIT} times)">
                        <i class="fa-solid fa-lock text-[10px]"></i> Limit (${reschedCount}/${MAX_RESCHEDULE_LIMIT})
                    </button>
                `;
            } else if (reschedStatus === 'requested') {
                reschedActionHtml = `
                    <button onclick="openRescheduleModalById(${appt.appointment_id})"
                            class="h-8 bg-[#D5C04D] hover:bg-[#c6b242] text-[#2A1001] text-xs font-bold px-3 rounded-full transition active:scale-95 cursor-pointer shadow-sm inline-flex items-center justify-center gap-1 shrink-0 whitespace-nowrap" 
                            title="Update pending reschedule request">
                        <i class="fa-solid fa-arrows-rotate text-[10px]"></i> Update Req
                    </button>
                    <button onclick="cancelRescheduleRequest(${appt.appointment_id})"
                            class="h-8 bg-gray-100 hover:bg-gray-200 text-red-600 text-xs font-bold px-2.5 rounded-full border border-red-200 transition active:scale-95 cursor-pointer inline-flex items-center justify-center shrink-0 whitespace-nowrap"
                            title="Cancel pending reschedule request">
                        <i class="fa-solid fa-xmark text-[10px]"></i> Cancel Req
                    </button>
                `;
            } else {
                reschedActionHtml = `
                    <button onclick="openRescheduleModalById(${appt.appointment_id})"
                            class="h-8 bg-[#D5C04D] hover:bg-[#c6b242] text-[#2A1001] text-xs font-bold px-3 rounded-full transition active:scale-95 cursor-pointer shadow-sm inline-flex items-center justify-center gap-1 shrink-0 whitespace-nowrap" 
                            title="Request a new date/time (${reschedCount}/${MAX_RESCHEDULE_LIMIT} used)">
                        <i class="fa-solid fa-calendar-days text-[10px]"></i> Reschedule
                    </button>
                `;
            }
        }

        // 🏷️ Refund Badge Logic (Shows under Cancelled)
        let refundStatusHtml = '';
        if (status === 'cancelled') {
            if (paymentStatus === 'refund_pending') {
                refundStatusHtml = `
                    <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[9px] font-extrabold bg-blue-100 text-blue-800 border border-blue-300 uppercase tracking-wide">
                        <i class="fa-solid fa-arrows-rotate fa-spin text-[8px] text-blue-600"></i> Refund Processing...
                    </span>
                `;
            } else if (paymentStatus === 'refunded') {
                refundStatusHtml = `
                    <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[9px] font-extrabold bg-green-100 text-green-800 border border-green-300 uppercase tracking-wide">
                        <i class="fa-solid fa-circle-check text-[8px] text-green-600"></i> Refund Approved
                    </span>
                `;
            }
        }

        row.innerHTML = `
            <!-- 1. Service Column -->
            <td class="py-4 px-4 sm:px-6 align-middle">
                <div class="font-black text-sm text-[#2A1001]">${escapeHtml(appt.label || 'General Treatment')}</div>
                <div class="text-xs text-[#667733] font-bold mt-0.5">${amountFormatted}</div>
            </td>

            <!-- 2. Attending Dentist Column -->
            <td class="py-4 px-4 sm:px-6 align-middle">
                ${dentistColumnHtml}
            </td>

            <!-- 3. Schedule Column -->
            <td class="py-4 px-4 sm:px-6 align-middle">
                <div class="text-[#2A1001] font-bold text-xs sm:text-sm flex items-center gap-1.5">
                    <i class="fa-regular fa-calendar text-gray-400 text-xs"></i> ${scheduledDate}
                </div>
                <div class="text-xs text-gray-600 font-extrabold mt-0.5 flex items-center gap-1.5">
                    <i class="fa-regular fa-clock text-[#667733] text-[11px]"></i> 
                    <span>${getFormattedTimeRange(appt.time_slot, appt.end_time_slot, appt.label)}</span>
                </div>
                ${isReschedPending ? `
                    <div class="text-[10px] text-amber-900 font-extrabold mt-1.5 inline-flex items-center gap-1 bg-amber-100 px-2 py-0.5 rounded-md border border-amber-300">
                        <i class="fa-solid fa-arrows-rotate fa-spin text-amber-700"></i> Resched: ${escapeHtml(appt.requested_date || '')} (${formatTime12h(appt.requested_time)})
                    </div>
                ` : ''}
            </td>

            <!-- 4. Status Column (With Refund Status) -->
            <td class="py-4 px-4 sm:px-6 text-center align-middle">
                <div class="flex flex-col items-center justify-center gap-1">
                    ${renderStatusBadge(appt.appointment_status)}
                    ${refundStatusHtml}
                    ${isReschedPending ? `
                        <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-black bg-amber-100 text-amber-900 border border-amber-300 uppercase">
                            Resched Requested
                        </span>
                    ` : ''}
                </div>
            </td>

            <!-- 5. Actions Column (Centered & Perfectly Aligned) -->
            <td class="py-4 px-4 sm:px-6 text-center align-middle">
                <div class="flex items-center justify-center gap-2 flex-nowrap">
                    ${reschedActionHtml}

                    <button onclick="openDetailModalById(${appt.appointment_id})"
                            class="h-8 bg-[#667733] hover:bg-[#556022] text-white text-xs font-bold px-3.5 rounded-full transition inline-flex items-center justify-center gap-1 shadow-sm active:scale-95 cursor-pointer shrink-0 whitespace-nowrap" title="View details and receipt">
                        <i class="fa-solid fa-receipt text-[10px]"></i> Receipt
                    </button>

                    ${isCancellable ? `
                        <button onclick="openCancelModal(${appt.appointment_id})"
                                class="h-8 bg-[#D9534F] hover:bg-[#c9302c] text-white text-xs font-bold px-3.5 rounded-full transition active:scale-95 cursor-pointer shadow-sm inline-flex items-center justify-center gap-1 shrink-0 whitespace-nowrap" title="Cancel this appointment">
                            <i class="fa-solid fa-ban text-[10px]"></i> Cancel
                        </button>
                    ` : ''}
                </div>
            </td>
        `;
        tbody.appendChild(row);
    });

    renderPagination(filteredAppointments.length);
}

function renderStatusBadge(status) {
    const s = (status || '').toLowerCase();
    if (s === 'completed') {
        return `<span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-extrabold bg-[#c2d09c] text-[#1a281b] border border-[#1a281b]/30"><span class="w-1.5 h-1.5 rounded-full bg-[#394a28] mr-1.5"></span>Completed</span>`;
    } else if (s === 'approved') {
        return `<span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-extrabold bg-[#9ea988] text-[#1a281b] border border-[#1a281b]/30"><span class="w-1.5 h-1.5 rounded-full bg-[#273a21] mr-1.5"></span>Approved</span>`;
    } else if (s === 'pending') {
        return `<span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-extrabold bg-[#F1B770] text-[#2A1001] border border-[#2A1001]/20"><span class="w-1.5 h-1.5 rounded-full bg-[#6a5416] mr-1.5"></span>Pending</span>`;
    } else if (s === 'cancelled') {
        return `<span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-extrabold bg-red-100 text-red-700 border border-red-300"><span class="w-1.5 h-1.5 rounded-full bg-red-600 mr-1.5"></span>Cancelled</span>`;
    }
    return `<span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-gray-100 text-gray-700">${escapeHtml(status)}</span>`;
}

function renderPaymentStatusBadge(paymentStatus) {
    const s = (paymentStatus || '').toLowerCase();
    if (s === 'paid') {
        return `<span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-[#c2d09c] text-[#1a281b] border border-[#1a281b]/30"><span class="w-1.5 h-1.5 rounded-full bg-[#394a28] mr-1.5"></span>Paid</span>`;
    } else if (s === 'pending') {
        return `<span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-800 border border-amber-300"><span class="w-1.5 h-1.5 rounded-full bg-amber-600 mr-1.5"></span>Awaiting Confirmation</span>`;
    } else if (s === 'refunded' || s === 'refund_pending') {
        return `<span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-800 border border-blue-300"><span class="w-1.5 h-1.5 rounded-full bg-blue-600 mr-1.5"></span>${s === 'refunded' ? 'Refunded' : 'Refund Pending'}</span>`;
    }
    return `<span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-gray-100 text-gray-700 border border-gray-300"><span class="w-1.5 h-1.5 rounded-full bg-gray-500 mr-1.5"></span>Unpaid</span>`;
}

function renderPagination(totalItems) {
    const pagination = document.getElementById('pagination');
    if (!pagination) return;
    pagination.innerHTML = '';

    const totalPages = Math.max(1, Math.ceil(totalItems / rowsPerPage));
    if (totalPages <= 1) return;

    const maxVisible = 5;
    const currentBatch = Math.floor((currentPage - 1) / maxVisible);
    const batchStart = currentBatch * maxVisible + 1;
    const batchEnd = Math.min(batchStart + maxVisible - 1, totalPages);

    if (batchStart > 1) {
        const prevBtn = document.createElement('button');
        prevBtn.innerHTML = '&lsaquo;';
        prevBtn.className = "w-9 h-9 rounded-full font-bold text-[#2A1001] bg-white border border-[#2A1001]/20 hover:bg-[#2A1001]/10 transition flex items-center justify-center cursor-pointer";
        prevBtn.addEventListener('click', () => { currentPage = batchStart - 1; renderTable(); });
        pagination.appendChild(prevBtn);
    }

    for (let i = batchStart; i <= batchEnd; i++) {
        const btn = document.createElement('button');
        btn.textContent = i;
        btn.className = `w-9 h-9 rounded-full font-bold text-xs cursor-pointer transition ${i === currentPage ? 'bg-[#667733] text-white shadow-sm' : 'bg-white text-[#2A1001] border border-[#2A1001]/20 hover:bg-gray-50'}`;
        btn.addEventListener('click', () => { currentPage = i; renderTable(); });
        pagination.appendChild(btn);
    }

    if (batchEnd < totalPages) {
        const nextBtn = document.createElement('button');
        nextBtn.innerHTML = '&rsaquo;';
        nextBtn.className = "w-9 h-9 rounded-full font-bold text-[#2A1001] bg-white border border-[#2A1001]/20 hover:bg-[#2A1001]/10 transition flex items-center justify-center cursor-pointer";
        nextBtn.addEventListener('click', () => { currentPage = batchEnd + 1; renderTable(); });
        pagination.appendChild(nextBtn);
    }
}

function openDetailModalById(id) {
    const appt = allAppointments.find(a => a.appointment_id == id);
    if (appt) openDetailModal(appt);
}

// ── Detail & Receipt Modal with Overflow Fix ──
function openDetailModal(appt) {
    currentSelectedAppt = appt;

    const scheduledDate = appt.appointment_date
        ? new Date(appt.appointment_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
        : 'N/A';

    const rawAmount = Number(appt.amount || 0);
    const subtotal = rawAmount / 1.12;
    const vatAmount = rawAmount - subtotal;
    const amountFormatted = `₱${rawAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const subtotalFormatted = `₱${subtotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const vatFormatted = `₱${vatAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const method = appt.method ? (String(appt.method).toLowerCase() === 'online' ? 'PAYMONGO' : String(appt.method).toUpperCase()) : 'IN-CLINIC CASH';
    const service = escapeHtml(appt.label || 'General Dental Treatment');
    const patientName = escapeHtml((appt.patient_first_name || appt.patient_last_name)
        ? `${appt.patient_first_name || ''} ${appt.patient_last_name || ''}`.trim()
        : 'Valued Patient');

    const dentistNote = appt.dentist_note ? escapeHtml(appt.dentist_note) : null;
    const patientId = escapeHtml(appt.public_id || `PAT-${appt.appointment_id}`);
    const receiptNo = escapeHtml(`OR-${(appt.appointment_date || '').replace(/-/g, '')}-${appt.appointment_id}`);

    let dentistDisplayHtml = '';
    const dentistFullName = (appt.dentist_first_name || appt.dentist_last_name)
        ? `Dr. ${appt.dentist_first_name || ''} ${appt.dentist_last_name || ''}`.trim()
        : null;

    if (dentistFullName) {
        dentistDisplayHtml = `
            <div class="min-w-0">
                <span class="text-[11px] text-[#2A1001]/60 font-bold block uppercase tracking-wide">Attending Dentist</span>
                <span class="inline-flex items-center gap-1 font-extrabold text-sm text-[#667733] truncate max-w-full">
                    <i class="fa-solid fa-user-doctor"></i> ${escapeHtml(dentistFullName)}
                </span>
            </div>
        `;
    } else {
        dentistDisplayHtml = `
            <div>
                <span class="text-[11px] text-[#2A1001]/60 font-bold block uppercase tracking-wide">Attending Dentist</span>
                <span class="italic text-xs text-gray-500 font-semibold bg-gray-100 px-2.5 py-0.5 rounded-full inline-block">
                    Any Available Dentist
                </span>
            </div>
        `;
    }

    let reschedNotice = '';
    const isReschedPending = appt.reschedule_status === 'requested' && 
                             appt.appointment_status !== 'cancelled' && 
                             appt.appointment_status !== 'completed';

    if (isReschedPending) {
        reschedNotice = `
            <div class="p-3.5 bg-amber-50 rounded-2xl border border-amber-300 flex items-start gap-3 text-xs text-amber-900 shadow-sm max-w-full overflow-hidden">
                <i class="fa-solid fa-arrows-rotate text-amber-600 text-lg mt-0.5 shrink-0"></i>
                <div class="flex-1 min-w-0">
                    <span class="font-extrabold block text-amber-900 uppercase tracking-wide text-xs">Pending Reschedule Request</span>
                    <p class="mt-0.5 text-xs">Requested Schedule: <strong>${escapeHtml(appt.requested_date || '')} at ${escapeHtml(appt.requested_time || '')}</strong></p>
                    <p class="italic text-amber-800 mt-1 break-words" style="word-break: break-word; overflow-wrap: anywhere;">Reason: "${escapeHtml(appt.reschedule_reason || 'Schedule Conflict')}"</p>
                </div>
            </div>
        `;
    }

    document.getElementById('detail-modal-body').innerHTML = `
        <div class="flex flex-col sm:flex-row justify-between sm:items-center pb-3 border-b border-dashed border-[#2A1001]/20 gap-2">
            <div>
                <span class="text-[10px] sm:text-xs text-[#2A1001]/60 uppercase tracking-wider font-bold">Official Receipt No.</span>
                <p class="font-extrabold text-sm sm:text-base text-[#2A1001] font-mono break-all">${receiptNo}</p>
            </div>
            <div class="sm:text-right">
                <span class="text-[10px] sm:text-xs text-[#2A1001]/60 uppercase tracking-wider font-bold block mb-1">Current Status</span>
                ${renderStatusBadge(appt.appointment_status)}
            </div>
        </div>

        ${reschedNotice}

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 py-1">
            <div class="min-w-0">
                <span class="text-[11px] text-[#2A1001]/60 font-bold block uppercase tracking-wide">Patient Name</span>
                <span class="font-extrabold text-sm text-[#2A1001] break-words">${patientName} (${patientId})</span>
            </div>
            ${dentistDisplayHtml}
            <div>
                <span class="text-[11px] text-[#2A1001]/60 font-bold block uppercase tracking-wide">Scheduled Time</span>
                <span class="font-extrabold text-sm text-[#2A1001]">${scheduledDate} &bull; ${getFormattedTimeRange(appt.time_slot, appt.end_time_slot, appt.label)}</span>
            </div>
            <div>
                <span class="text-[11px] text-[#2A1001]/60 font-bold block uppercase tracking-wide">Payment Mode</span>
                <span class="font-extrabold text-sm text-[#2A1001]">${method}</span>
            </div>
            <div>
                <span class="text-[11px] text-[#2A1001]/60 font-bold block uppercase tracking-wide">Payment Status</span>
                ${renderPaymentStatusBadge(appt.payment_status)}
            </div>
        </div>

        <!-- 🧾 Statement & 12% VAT Breakdown Table (Strictly Fixed Layout) -->
        <div class="mt-2 pt-3 border-t border-[#2A1001]/10 w-full overflow-hidden">
            <table class="w-full text-xs sm:text-sm table-fixed">
                <thead>
                    <tr class="text-[#2A1001]/70 border-b border-[#2A1001]/10 uppercase text-[10px] tracking-wider">
                        <th class="text-left py-2 font-extrabold w-[65%]">Service &amp; Description</th>
                        <th class="text-right py-2 font-extrabold w-[35%]">Amount</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td class="py-2.5 pr-2 align-top break-words max-w-0" style="word-break: break-word; overflow-wrap: anywhere;">
                            <p class="font-bold text-[#2A1001] text-sm break-words">${service}</p>
                            <p class="text-xs text-[#2A1001]/60 mt-0.5 break-words" style="word-break: break-word; overflow-wrap: anywhere;">${escapeHtml(appt.patient_note || 'Standard consultation and dental treatment')}</p>
                        </td>
                        <td class="text-right py-2.5 font-extrabold text-[#2A1001] text-sm align-top whitespace-nowrap">${amountFormatted}</td>
                    </tr>
                </tbody>
                <tfoot class="border-t border-[#2A1001]/10 text-xs">
                    <tr>
                        <td class="pt-2 text-[#2A1001]/70">Subtotal (VAT Exclusive):</td>
                        <td class="pt-2 text-right font-bold text-[#2A1001] whitespace-nowrap">${subtotalFormatted}</td>
                    </tr>
                    <tr>
                        <td class="py-1 text-[#2A1001]/70">Value Added Tax (12% VAT):</td>
                        <td class="py-1 text-right font-bold text-[#2A1001] whitespace-nowrap">${vatFormatted}</td>
                    </tr>
                    <tr class="border-t-2 border-[#2A1001]/20 font-black text-sm sm:text-base">
                        <td class="pt-2 text-[#2A1001]">Total Amount Due / Paid:</td>
                        <td class="pt-2 text-right text-[#667733] whitespace-nowrap">${amountFormatted}</td>
                    </tr>
                </tfoot>
            </table>
        </div>

        ${dentistNote ? `
            <div class="p-3.5 bg-green-50 rounded-2xl border border-green-200 text-xs text-green-950 shadow-inner max-w-full overflow-hidden">
                <span class="font-bold block mb-1">Dentist Clinical Remarks & Instructions:</span>
                <p class="italic break-words" style="word-break: break-word; overflow-wrap: anywhere;">${dentistNote}</p>
            </div>
        ` : ''}
    `;

    document.getElementById('detail-modal').classList.remove('hidden');
}

function closeDetailModal() {
    const modal = document.getElementById('detail-modal');
    if (modal) modal.classList.add('hidden');
}

function printCurrentReceipt() {
    if (!currentSelectedAppt) return;
    const a = currentSelectedAppt;
    const rawAmt = Number(a.amount || 0);
    const subtotal = rawAmt / 1.12;
    const vat = rawAmt - subtotal;

    const formattedAmount = `₱${rawAmt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const formattedSubtotal = `₱${subtotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const formattedVat = `₱${vat.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const receiptNo = `OR-${(a.appointment_date || '').replace(/-/g, '')}-${a.appointment_id}`;
    const patientName = `${a.patient_first_name || ''} ${a.patient_last_name || ''}`.trim() || 'Valued Patient';
    const dentistName = (a.dentist_first_name || a.dentist_last_name)
        ? `Dr. ${a.dentist_first_name || ''} ${a.dentist_last_name || ''}`.trim()
        : 'Any Available Dentist';

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
            .total-row { font-weight: bold; font-size: 14px; }
            .footer { margin-top: 40px; text-align: center; font-size: 11px; color: #888; border-top: 1px solid #ccc; padding-top: 10px; }
        </style>
    </head>
    <body>
        <div class="header">
            <h1>BUNGIPIN DENTAL CLINIC</h1>
            <p>Official Patient Appointment Receipt &amp; Statement of Service</p>
            <p>Printed on: ${new Date().toLocaleDateString()}</p>
        </div>
        <table style="width: 100%; margin-bottom: 20px;">
            <tr>
                <td><strong>Receipt No:</strong> ${escapeHtml(receiptNo)}</td>
                <td style="text-align: right;"><strong>Date:</strong> ${escapeHtml(a.appointment_date)}</td>
            </tr>
            <tr>
                <td><strong>Patient:</strong> ${escapeHtml(patientName)} (${escapeHtml(a.public_id || `PAT-${a.appointment_id}`)})</td>
                <td style="text-align: right;"><strong>Status:</strong> ${escapeHtml(a.appointment_status).toUpperCase()}</td>
            </tr>
            <tr>
                <td><strong>Attending Dentist:</strong> ${escapeHtml(dentistName)}</td>
                <td style="text-align: right;"><strong>Time Slot:</strong> ${getFormattedTimeRange(a.time_slot, a.end_time_slot, a.label)}</td>
            </tr>
            <tr>
                <td><strong>Payment Mode:</strong> ${escapeHtml((a.method || 'In-Clinic Cash').toUpperCase())}</td>
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
                        <strong>${escapeHtml(a.label || 'General Dental Treatment')}</strong><br>
                        <span style="font-size: 11px; color: #666;">${escapeHtml(a.patient_note || 'Standard consultation and dental treatment')}</span>
                    </td>
                    <td style="text-align: right; font-weight: bold;">${formattedAmount}</td>
                </tr>
                <tr>
                    <td style="text-align: right; font-size: 12px; color: #666;">Subtotal (VAT Exclusive):</td>
                    <td style="text-align: right; font-size: 12px;">${formattedSubtotal}</td>
                </tr>
                <tr>
                    <td style="text-align: right; font-size: 12px; color: #666;">Value Added Tax (12% VAT):</td>
                    <td style="text-align: right; font-size: 12px;">${formattedVat}</td>
                </tr>
                <tr class="total-row">
                    <td style="text-align: right; padding-top: 10px; border-top: 2px solid #2A1001;">Total Paid / Amount Due:</td>
                    <td style="text-align: right; padding-top: 10px; border-top: 2px solid #2A1001; color: #667733;">${formattedAmount}</td>
                </tr>
            </tbody>
        </table>

        ${a.dentist_note ? `
            <div style="margin-top: 15px; padding: 10px; border: 1px dashed #aaa; border-radius: 6px; font-size: 11px;">
                <strong>Dentist Clinical Notes:</strong> ${escapeHtml(a.dentist_note)}
            </div>
        ` : ''}

        <div class="footer">
            <p>Thank you for choosing Bungipin Dental Clinic for your oral healthcare!</p>
            <p>This document serves as an electronic official receipt statement.</p>
        </div>
    </body>
    </html>`;

    document.getElementById('printFrame')?.remove();
    const frame = document.createElement('iframe');
    frame.id = 'printFrame';
    frame.style.cssText = 'position:fixed; right:0; bottom:0; width:0; height:0; border:0;';
    frame.onload = () => {
        frame.contentWindow.focus();
        frame.contentWindow.print();
    };
    frame.srcdoc = printHtml;
    document.body.appendChild(frame);
}

function openCancelModal(appointmentId) {
    appointmentToCancelId = appointmentId;
    const cancelModal = document.getElementById('cancel-modal');
    const confirmButton = document.getElementById('confirm-cancel-btn');
    const reasonError = document.getElementById('cancelReasonError');
    const customContainer = document.getElementById('customCancelReasonContainer');
    const customText = document.getElementById('customCancelReasonText');

    if (!cancelModal) return;

    document.querySelectorAll('input[name="cancelReasonRadio"]').forEach(r => r.checked = false);

    if (customContainer) customContainer.classList.add('hidden');
    if (customText) customText.value = '';
    if (reasonError) reasonError.classList.add('hidden');

    const refundNotice = document.getElementById('cancelRefundNotice');
    const refundText = document.getElementById('cancelRefundNoticeText');
    const appt = allAppointments.find(a => Number(a.appointment_id) === Number(appointmentId));
    if (refundNotice && refundText) {
        const paid = appt && ['paid', 'refund_pending', 'pending'].includes(String(appt.payment_status || '').toLowerCase());
        if (paid) {
            const amt = Number(appt.amount || 0).toLocaleString('en-PH', { style: 'currency', currency: 'PHP' });
            refundText.textContent = String(appt.method).toLowerCase() === 'online'
                ? `You paid ${amt} online. Cancelling will automatically process a refund to your account.`
                : `You paid ${amt} at the clinic. Please visit the clinic to receive your cash refund.`;
            refundNotice.classList.remove('hidden');
        } else {
            refundNotice.classList.add('hidden');
        }
    }

    cancelModal.classList.remove('hidden');

    if (confirmButton) {
        confirmButton.disabled = false;
        confirmButton.textContent = 'Yes, Cancel It';
        confirmButton.onclick = () => cancelAppointment(appointmentId);
    }
}

function closeCancelModal() {
    const cancelModal = document.getElementById('cancel-modal');
    if (cancelModal) cancelModal.classList.add('hidden');
    appointmentToCancelId = null;
}

async function cancelAppointment(appointmentId) {
    const token = localStorage.getItem('userToken');
    const confirmButton = document.getElementById('confirm-cancel-btn');
    const reasonError = document.getElementById('cancelReasonError');

    const selectedRadio = document.querySelector('input[name="cancelReasonRadio"]:checked');

    if (!selectedRadio) {
        if (reasonError) {
            reasonError.textContent = '⚠️ Please select a reason for cancellation.';
            reasonError.classList.remove('hidden');
        }
        return;
    }

    let finalReason = selectedRadio.value;

    if (finalReason === 'other') {
        const customText = document.getElementById('customCancelReasonText')?.value.trim();
        if (!customText) {
            if (reasonError) {
                reasonError.textContent = '⚠️ Please specify your reason in the text box.';
                reasonError.classList.remove('hidden');
            }
            document.getElementById('customCancelReasonText')?.focus();
            return;
        }
        finalReason = customText;
    }

    if (reasonError) reasonError.classList.add('hidden');

    if (!token && !TEST_MODE) {
        closeCancelModal();
        showNotice('Your session has expired. Please log in again.', { title: 'Session Expired', type: 'error' });
        return;
    }

    if (confirmButton) {
        confirmButton.disabled = true;
        confirmButton.textContent = 'Cancelling...';
    }

    try {
        const response = await fetch(`/api/appointments/${appointmentId}/cancel`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ reason: finalReason })
        });

        if (response.ok) {
            closeCancelModal();
            await fetchAppointments();
            const result = await response.json();
            showNotice(result.message || 'Your appointment has been cancelled.', { title: 'Appointment Cancelled', type: 'success' });
        } else {
            const err = await response.json();
            showNotice(err.message || 'Please try again.', { title: 'Failed to Cancel', type: 'error' });
        }
    } catch(err) {
        console.error("Cancel error:", err);
        showNotice('Please check your connection and try again.', { title: 'Error Cancelling', type: 'error' });
    } finally {
        if (confirmButton) {
            confirmButton.disabled = false;
            confirmButton.textContent = 'Yes, Cancel It';
        }
    }
}

async function cancelRescheduleRequest(appointmentId) {
    const token = localStorage.getItem('userToken');
    if (!token && !TEST_MODE) {
        showNotice('Please log in again.', { title: 'Session Expired', type: 'error' });
        return;
    }

    try {
        const response = await fetch(`/api/appointments/${appointmentId}/cancel-reschedule`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const result = await response.json();

        if (response.ok) {
            await fetchAppointments();
            showNotice('Your reschedule request has been cancelled.', { title: 'Request Cancelled', type: 'success' });
        } else {
            showNotice(result.message || 'Could not cancel request.', { title: 'Error', type: 'error' });
        }
    } catch (err) {
        console.error('Error cancelling reschedule:', err);
        showNotice('Failed to cancel request.', { title: 'Error', type: 'error' });
    }
}

function openRescheduleModalById(appointmentId) {
    const appt = allAppointments.find(a => a.appointment_id == appointmentId);
    if (appt) openRescheduleModal(appt);
}

async function openRescheduleModal(appt) {
    const reschedCount = Number(appt.reschedule_count || 0);
    const isUpdating = appt.reschedule_status === 'requested';

    if (reschedCount >= MAX_RESCHEDULE_LIMIT && !isUpdating) {
        showNotice(`You have reached the maximum allowed reschedules (${MAX_RESCHEDULE_LIMIT} times) for this appointment.`, { title: 'Limit Reached', type: 'error' });
        return;
    }

    pendingRescheduleAppt = appt;

    const scheduledDate = appt.appointment_date
        ? new Date(appt.appointment_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
        : 'N/A';

    const summaryEl = document.getElementById('reschedulePatientSummary');
    if (summaryEl) {
        summaryEl.innerHTML = `
            ${escapeHtml(appt.label || 'Your appointment')} &bull; Currently: <strong>${escapeHtml(scheduledDate)}</strong> at <strong>${getFormattedTimeRange(appt.time_slot, appt.end_time_slot, appt.label)}</strong>
            <span class="inline-block mt-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-[#EAF0DD] text-[#556022] border border-[#667733]/30">
                Reschedule Limit: ${reschedCount} / ${MAX_RESCHEDULE_LIMIT} used
            </span>
        `;
    }

    reschedSelectedDate = null;
    reschedSelectedDateFormatted = null;
    reschedSelectedTime = null;
    reschedSelectedEndTime = null;
    reschedCurrentDate = new Date();

    document.querySelectorAll('input[name="reschedReasonRadio"]').forEach(r => r.checked = false);

    const customContainer = document.getElementById('customReasonContainer');
    const customText = document.getElementById('customReasonText');
    if (customContainer) customContainer.classList.add('hidden');
    if (customText) customText.value = '';

    renderReschedCalendar(reschedCurrentDate);
    renderReschedAvailableSlots(null);
    updateReschedSummaryDisplay();

    document.getElementById('reschedule-modal').classList.remove('hidden');
}

function closeRescheduleModal() {
    const modal = document.getElementById('reschedule-modal');
    if (modal) modal.classList.add('hidden');
    pendingRescheduleAppt = null;
}

const MAX_ADVANCE_MONTHS = 6;

function renderReschedCalendar(date) {
    const monthYearEl = document.getElementById('reschedMonthYear');
    const daysContainer = document.getElementById('reschedDays');
    const reschedPrev = document.getElementById('reschedPrev');
    const reschedNext = document.getElementById('reschedNext');
    if (!monthYearEl || !daysContainer) return;

    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const lastDay = new Date(year, month + 1, 0).getDate();

    const maxReschedDate = new Date(reschedToday);
    maxReschedDate.setMonth(maxReschedDate.getMonth() + MAX_ADVANCE_MONTHS);

    monthYearEl.textContent = `${months[month]} ${year}`;
    daysContainer.innerHTML = '';

    if (reschedPrev) {
        const isCurrentMonth = (year === reschedToday.getFullYear() && month === reschedToday.getMonth());
        reschedPrev.style.opacity = isCurrentMonth ? '0.3' : '1';
        reschedPrev.style.pointerEvents = isCurrentMonth ? 'none' : 'auto';
    }

    if (reschedNext) {
        const isMaxMonth = (year > maxReschedDate.getFullYear()) || (year === maxReschedDate.getFullYear() && month >= maxReschedDate.getMonth());
        reschedNext.style.opacity = isMaxMonth ? '0.3' : '1';
        reschedNext.style.pointerEvents = isMaxMonth ? 'none' : 'auto';
    }

    function handleDayClick(dayDiv, displayDateStr, sqlDateStr) {
        dayDiv.addEventListener('click', function () {
            document.querySelectorAll('#reschedDays > div').forEach(d => {
                d.classList.remove('bg-[#667733]', 'text-white', 'border-2', 'border-[#2A1001]');
            });
            dayDiv.classList.add('bg-[#667733]', 'text-white');

            reschedSelectedDate = displayDateStr;
            reschedSelectedDateFormatted = sqlDateStr;
            reschedSelectedTime = null;
            reschedSelectedEndTime = null;

            updateReschedSummaryDisplay();
            renderReschedAvailableSlots(sqlDateStr);
        });
    }

    const prevMonthLastDay = new Date(year, month, 0).getDate();
    for (let i = firstDay; i > 0; i--) {
        const dayDiv = document.createElement('div');
        dayDiv.className = 'w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center font-medium text-gray-300 select-none text-xs';
        dayDiv.textContent = prevMonthLastDay - i + 1;
        daysContainer.appendChild(dayDiv);
    }

    for (let i = 1; i <= lastDay; i++) {
        const dayDiv = document.createElement('div');
        const cellDate = new Date(year, month, i);

        const isPast = cellDate < new Date(reschedToday.getFullYear(), reschedToday.getMonth(), reschedToday.getDate());
        const isBeyondLimit = cellDate > maxReschedDate;
        const isDisabled = isPast || isBeyondLimit;

        dayDiv.className = 'w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center font-bold text-xs text-[#2A1001] transition-all';
        dayDiv.textContent = i;

        if (isDisabled) {
            dayDiv.className = 'w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center font-medium text-gray-300 cursor-not-allowed select-none text-xs bg-gray-50';
        } else {
            dayDiv.classList.add('cursor-pointer', 'hover:bg-[#D7E3A5]', 'hover:scale-110');
        }

        if (i === reschedToday.getDate() && month === reschedToday.getMonth() && year === reschedToday.getFullYear()) {
            dayDiv.classList.add('border-2', 'border-[#667733]', 'bg-[#FDFCE9]');
        }

        const displayStr = `${months[month]} ${i}, ${year}`;
        const formattedMonth = String(month + 1).padStart(2, '0');
        const formattedDay = String(i).padStart(2, '0');
        const sqlStr = `${year}-${formattedMonth}-${formattedDay}`;

        if (reschedSelectedDateFormatted === sqlStr) {
            dayDiv.classList.add('bg-[#667733]', 'text-white');
        }

        if (!isDisabled) handleDayClick(dayDiv, displayStr, sqlStr);
        daysContainer.appendChild(dayDiv);
    }

    const totalRendered = firstDay + lastDay;
    const remainingCells = (7 - (totalRendered % 7)) % 7;
    for (let i = 1; i <= remainingCells; i++) {
        const dayDiv = document.createElement('div');
        dayDiv.className = 'w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center font-medium text-gray-300 select-none text-xs';
        dayDiv.textContent = i;
        daysContainer.appendChild(dayDiv);
    }
}

async function renderReschedAvailableSlots(dateStr) {
    const amContainer = document.getElementById('amSlotsContainer');
    const pmContainer = document.getElementById('pmSlotsContainer');
    const colsContainer = document.getElementById('slotsColumnsContainer');
    const msgContainer = document.getElementById('slotsMessageContainer');

    if (!amContainer || !pmContainer) return;

    if (!dateStr || !pendingRescheduleAppt) {
        if (colsContainer) colsContainer.classList.remove('hidden');
        if (msgContainer) msgContainer.classList.add('hidden');
        amContainer.innerHTML = '<p class="text-[11px] text-center text-gray-400 py-3">Select a date</p>';
        pmContainer.innerHTML = '<p class="text-[11px] text-center text-gray-400 py-3">Select a date</p>';
        return;
    }

    if (colsContainer) colsContainer.classList.add('hidden');
    if (msgContainer) {
        msgContainer.classList.remove('hidden');
        msgContainer.innerHTML = '<p class="text-xs text-gray-500 py-6"><i class="fa-solid fa-spinner fa-spin mr-1.5 text-[#667733]"></i> Checking dentist schedule...</p>';
    }

    const doctorId = pendingRescheduleAppt.dentist_id || pendingRescheduleAppt.employee_id || 1;
    const duration = calculateApptDuration(pendingRescheduleAppt);
    const token = localStorage.getItem('userToken');

    try {
        const res = await fetch(`/api/doctors/${doctorId}/available-slots?date=${dateStr}&duration=${duration}`, {
            headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });

        const data = await res.json();
        
        if (!data.is_working_day || !data.slots || data.slots.length === 0) {
            if (colsContainer) colsContainer.classList.add('hidden');
            if (msgContainer) {
                msgContainer.classList.remove('hidden');
                msgContainer.innerHTML = `
                    <div class="flex flex-col items-center justify-center text-center py-6 px-3">
                        <i class="fa-regular fa-calendar-xmark text-amber-600 text-3xl mb-2"></i>
                        <p class="text-xs font-bold text-amber-900">${escapeHtml(data.message || 'Dentist is not on duty on this day (Closed).')}</p>
                        <p class="text-[11px] text-gray-500 mt-1">Please select another date on the calendar.</p>
                    </div>
                `;
            }
            return;
        }

        if (msgContainer) msgContainer.classList.add('hidden');
        if (colsContainer) colsContainer.classList.remove('hidden');

        amContainer.innerHTML = '';
        pmContainer.innerHTML = '';

        const amSlots = data.slots.filter(s => parseInt(s.time_slot.split(':')[0], 10) < 12);
        const pmSlots = data.slots.filter(s => parseInt(s.time_slot.split(':')[0], 10) >= 12);

        function createReschedBtn(slot) {
            const isSelected = reschedSelectedTime === slot.time_slot;
            const btn = document.createElement('button');
            btn.type = 'button';

            let baseClass = "w-full py-1.5 px-2 text-[11px] rounded-full border transition text-center font-bold ";

            if (slot.is_available) {
                btn.className = baseClass + (isSelected
                    ? 'bg-[#667733] text-white border-[#667733] shadow-sm'
                    : 'bg-white text-[#2A1001] border-black/20 hover:bg-[#D7E3A5]/40 cursor-pointer');
                btn.textContent = `${formatTime12h(slot.time_slot)} – ${formatTime12h(slot.end_time_slot)}`;
                btn.addEventListener('click', function () {
                    reschedSelectedTime = slot.time_slot;
                    reschedSelectedEndTime = slot.end_time_slot;
                    renderReschedAvailableSlots(dateStr);
                    updateReschedSummaryDisplay();
                });
            } else {
                btn.disabled = true;
                btn.className = baseClass + 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed line-through opacity-60';
                btn.textContent = `${formatTime12h(slot.time_slot)} (${slot.reason || 'Closed'})`;
            }
            return btn;
        }

        if (amSlots.length === 0) amContainer.innerHTML = '<p class="text-[10px] text-gray-400 italic py-2 text-center">No AM slots</p>';
        if (pmSlots.length === 0) pmContainer.innerHTML = '<p class="text-[10px] text-gray-400 italic py-2 text-center">No PM slots</p>';

        amSlots.forEach(s => amContainer.appendChild(createReschedBtn(s)));
        pmSlots.forEach(s => pmContainer.appendChild(createReschedBtn(s)));

    } catch (err) {
        if (colsContainer) colsContainer.classList.add('hidden');
        if (msgContainer) {
            msgContainer.classList.remove('hidden');
            msgContainer.innerHTML = '<p class="text-xs text-red-500 text-center py-4">Failed to load available slots.</p>';
        }
    }
}

function updateReschedSummaryDisplay() {
    const display = document.getElementById('reschedSelectedDateDisplay');
    const confirmBtn = document.getElementById('confirmRescheduleBtn');
    if (!display || !confirmBtn) return;

    const selectedRadio = document.querySelector('input[name="reschedReasonRadio"]:checked');
    let hasValidReason = false;

    if (selectedRadio) {
        if (selectedRadio.value === 'other') {
            hasValidReason = Boolean(document.getElementById('customReasonText')?.value.trim());
        } else {
            hasValidReason = true;
        }
    }

    if (reschedSelectedDate && reschedSelectedTime) {
        const timeRangeText = reschedSelectedEndTime
            ? `${formatTime12h(reschedSelectedTime)} – ${formatTime12h(reschedSelectedEndTime)}`
            : formatTime12h(reschedSelectedTime);
        
        display.innerHTML = `Requested Schedule: <strong class="text-[#667733]">${escapeHtml(reschedSelectedDate)}</strong> at <strong class="text-[#667733]">${timeRangeText}</strong>`;
        confirmBtn.disabled = !hasValidReason;
    } else if (reschedSelectedDate) {
        display.innerHTML = `Selected Date: <strong>${escapeHtml(reschedSelectedDate)}</strong> (Please choose an available AM or PM slot)`;
        confirmBtn.disabled = true;
    } else {
        display.textContent = 'No date selected yet.';
        confirmBtn.disabled = true;
    }
}

async function confirmReschedule() {
    if (!reschedSelectedDateFormatted || !reschedSelectedTime || !pendingRescheduleAppt) {
        showNotice('Please select both a date and a time slot.', { title: 'Incomplete Selection', type: 'error' });
        return;
    }

    const selectedRadio = document.querySelector('input[name="reschedReasonRadio"]:checked');
    if (!selectedRadio) {
        showNotice('Please choose a reason for rescheduling.', { title: 'Reason Required', type: 'error' });
        return;
    }

    let finalReason = selectedRadio.value;

    if (finalReason === 'other') {
        const customText = document.getElementById('customReasonText')?.value.trim();
        if (!customText) {
            showNotice('Please provide your specific reason for rescheduling in the text box.', { title: 'Reason Required', type: 'error' });
            document.getElementById('customReasonText')?.focus();
            return;
        }
        finalReason = customText;
    }

    const token = localStorage.getItem('userToken');
    const appointmentId = pendingRescheduleAppt.appointment_id;
    const confirmBtn = document.getElementById('confirmRescheduleBtn');

    if (!token && !TEST_MODE) {
        closeRescheduleModal();
        showNotice('Your session has expired. Please log in again.', { title: 'Session Expired', type: 'error' });
        return;
    }

    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Submitting Request...';
    }

    try {
        const response = await fetch(`/api/appointments/${appointmentId}/request-reschedule`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                requested_date: reschedSelectedDateFormatted,
                requested_time: reschedSelectedTime,
                end_time_slot: reschedSelectedEndTime,
                reschedule_reason: finalReason
            })
        });

        const result = await response.json().catch(() => ({}));

        if (response.ok) {
            closeRescheduleModal();
            await fetchAppointments();
            showNotice(result.message || 'Your reschedule request has been submitted. Our clinic team will review and approve your request shortly.', { title: 'Reschedule Requested', type: 'success' });
        } else {
            showNotice(result.message || 'Please try a different date or time.', { title: 'Could Not Request Reschedule', type: 'error' });
        }
    } catch (err) {
        console.error("Reschedule error:", err);
        showNotice('Please check your connection and try again.', { title: 'Error Rescheduling', type: 'error' });
    } finally {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Submit Reschedule Request';
        }
    }
}