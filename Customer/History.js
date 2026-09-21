// ── SET TO false WHEN BACKEND IS READY ─────────────────────────────────────
const TEST_MODE = false;

document.addEventListener('DOMContentLoaded', () => {
    fetchAppointments();
});

const MOCK_APPOINTMENTS = [
    {
        appointment_id: 1,
        label: 'Dental Checkup', // from services.label
        appointment_date: '2026-08-25', // from appointments.appointment_date
        time_slot: '10:00:00', // from appointments.time_slot
        created_at: '2026-08-25T10:30:00',
        amount: 450, // from payments.amount
        method: 'online', // from payments.method
        appointment_status: 'pending', // from appointments.appointment_status
        dentist_first_name: 'Ramon', // from users.first_name (employee)
        dentist_last_name: 'Cruz', // from users.last_name (employee)
        dentist_note: null, // from appointments.dentist_note
        public_id: 'PAT-0001', // from users.public_id
        phone: '0925-237-2975', // from users.phone
        address: 'Calino East Cave III', // from patient_profiles.address
        email: 'maria.santos@example.com' // from users.email
    },
    {
        appointment_id: 2,
        label: 'Cleaning Appointment',
        appointment_date: '2026-08-25',
        time_slot: '08:00:00',
        created_at: '2026-08-25T09:00:00',
        amount: 1500,
        method: 'online',
        appointment_status: 'completed',
        dentist_first_name: 'Liza',
        dentist_last_name: 'Tan',
        dentist_note: 'Yo bro I got ur cooked, you just have to take these meds i gave you, you hear me?',
        public_id: 'PAT-0001',
        phone: '0915-107-2442',
        address: 'Antipolo Bankers Village',
        email: 'maria.santos@example.com'
    },
    {
        appointment_id: 3,
        label: 'Dental Cleaning',
        appointment_date: '2026-08-26',
        time_slot: '14:00:00',
        created_at: '2026-08-26T11:00:00',
        amount: 800,
        method: 'card',
        appointment_status: 'approved',
        dentist_first_name: 'Ramon',
        dentist_last_name: 'Cruz',
        dentist_note: null,
        public_id: 'PAT-0001',
        phone: '0915-107-2442',
        address: 'Antipolo Bankers Village',
        email: 'maria.santos@example.com'
    }
];

async function fetchAppointments() {
    const appointmentList = document.getElementById('appointment-list');

    if (TEST_MODE) {
        renderAppointments(MOCK_APPOINTMENTS);
        return;
    }

    const token = localStorage.getItem('userToken');

    if (!token) {
        appointmentList.innerHTML = '<p class="text-center text-gray-500 py-6 font-bold">Please log in to view your appointments.</p>';
        return;
    }

    try {
        const response = await fetch('/api/appointments/mine', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.ok) {
            const appointments = await response.json();
            renderAppointments(appointments);
        } else {
            appointmentList.innerHTML = '<p class="text-center text-red-500 py-6 font-bold">Failed to load appointments.</p>';
        }
    } catch(err) {
        console.error("Network error:", err);
        appointmentList.innerHTML = '<p class="text-center text-red-500 py-6 font-bold">Error loading appointments.</p>';
    }
}

function renderAppointments(appointments) {
    const appointmentList = document.getElementById('appointment-list');
    appointmentList.innerHTML = '';

    if (!appointments || appointments.length === 0) {
        appointmentList.innerHTML = '<p class="text-center text-gray-500 py-6 font-bold">No appointments found. Book one today!</p>';
        return;
    }

    appointments.forEach(appt => {
        const card = buildCompactCard(appt);
        appointmentList.appendChild(card);
    });
}

// ── Compact list card (just title + date + status) ──────────────────────────
function buildCompactCard(appt) {
    const statusStyles = {
        pending:   { bg: 'bg-[#dcb954]', text: 'Pending' },
        approved:  { bg: 'bg-[#9ea988]', text: 'Approved' },
        completed: { bg: 'bg-[#c2d09c]', text: 'Completed' },
        cancelled: { bg: 'bg-red-400',   text: 'Cancelled' }
    };
    const style = statusStyles[appt.appointment_status] || { bg: 'bg-gray-300', text: appt.appointment_status };

    const scheduledDate = appt.appointment_date
        ? new Date(appt.appointment_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })
        : 'N/A';

    const card = document.createElement('div');
    card.className = 'w-full bg-white border-2 border-[#1a281b] rounded-md px-5 py-4 sm:px-6 sm:py-5 flex justify-between items-center shadow-sm cursor-pointer hover:bg-[#f7f5ee] transition-colors';
    card.id = `appt-card-${appt.appointment_id}`;
    card.onclick = () => openDetailModal(appt);

    card.innerHTML = `
        <div class="flex flex-col">
            <h3 class="font-extrabold text-[#1a281b] text-lg sm:text-xl tracking-wide">${appt.label || 'General Appointment'}</h3>
            <p class="font-bold text-sm text-[#1a281b] mt-0.5">Date: ${scheduledDate}</p>
        </div>
        <div class="${style.bg} border-2 border-[#1a281b] rounded-[4px] px-6 py-1.5 flex justify-center items-center shadow-sm min-w-[120px]">
            <span class="font-extrabold text-xs sm:text-sm text-[#1a281b]">${style.text}</span>
        </div>
    `;

    return card;
}

// ── Open detail modal with full receipt ─────────────────────────────────────
function openDetailModal(appt) {
    const statusStyles = {
        pending:   { bg: 'background-color:#dcb954', text: 'Pending' },
        approved:  { bg: 'background-color:#9ea988', text: 'Approved' },
        completed: { bg: 'background-color:#c2d09c', text: 'Completed' },
        cancelled: { bg: 'background-color:#f87171', text: 'Cancelled' }
    };
    const style = statusStyles[appt.appointment_status] || { bg: 'background-color:#d1d5db', text: appt.appointment_status };

    const scheduledDate = appt.appointment_date
        ? new Date(appt.appointment_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })
        : 'N/A';
    const amount      = appt.amount ? `${Number(appt.amount).toLocaleString()}php` : 'N/A';
    const method      = appt.method ? appt.method.charAt(0).toUpperCase() + appt.method.slice(1) : 'N/A';
    const paymentStatus = appt.payment_status
        ? appt.payment_status.charAt(0).toUpperCase() + appt.payment_status.slice(1)
        : 'N/A';
    const service     = appt.label || 'General Appointment';
    const dentistName = (appt.dentist_first_name || appt.dentist_last_name)
        ? `Dr. ${appt.dentist_first_name || ''} ${appt.dentist_last_name || ''}`.trim()
        : 'To be assigned';
    const dentistNote = appt.dentist_note || null;

    // Patient receipt fields — joined from users + patient_profiles on backend
    const patientId      = appt.public_id || 'N/A';  // users.public_id
    const patientPhone   = appt.phone     || 'N/A';  // users.phone
    const patientAddress = appt.address   || 'N/A';  // patient_profiles.address
    const patientEmail   = appt.email     || 'N/A';  // users.email

    // ── Status-specific bottom section ──────────────────────────────────────
    let bottomSection = '';

    if (appt.appointment_status === 'pending') {
        bottomSection = `
            <div class="flex items-end justify-between mt-4 pt-3 border-t border-[#d2dbbe]">
                <p class="text-sm text-[#4a5e3b] font-semibold italic max-w-[75%]">
                    Please be patient with our dentist your approval will arrive in a few moments
                </p>
                <img src="../assets/logowithtitle.png" onerror="this.src='../Customer/logowithtitle.png'" alt="Clinic Logo" class="w-14 h-14 object-contain shrink-0">
            </div>
            <div class="mt-3">
                <button
                    onclick="event.stopPropagation(); closeDetailModal(); openCancelModal(${appt.appointment_id})"
                    class="bg-red-500 hover:bg-red-600 text-white font-extrabold text-sm px-6 py-2 rounded-full border-2 border-[#1a281b] shadow-sm active:scale-95 transition-all cursor-pointer">
                    Cancel Appointment
                </button>
            </div>
        `;
    } else if (appt.appointment_status === 'approved') {
        bottomSection = `
            <div class="flex items-end justify-between mt-4 pt-3 border-t border-[#d2dbbe]">
                <p class="text-sm text-[#1a281b] font-semibold">
                    Your dentist <span class="font-extrabold">${dentistName}</span> has been assigned to you.
                </p>
                <img src="../assets/logowithtitle.png" onerror="this.src='../Customer/logowithtitle.png'" alt="Clinic Logo" class="w-14 h-14 object-contain shrink-0">
            </div>
        `;
    } else if (appt.appointment_status === 'completed') {
        bottomSection = `
            <div class="mt-4 pt-3 border-t border-[#d2dbbe]">
                <p class="text-sm text-[#1a281b] font-bold mb-1">Note from your dentist:</p>
                <div class="flex items-end justify-between gap-4">
                    <p class="text-sm text-[#1a281b] italic">${dentistNote || 'No notes left by dentist.'}</p>
                    <img src="../assets/logowithtitle.png" onerror="this.src='../Customer/logowithtitle.png'" alt="Clinic Logo" class="w-14 h-14 object-contain shrink-0">
                </div>
            </div>
        `;
    } else if (appt.appointment_status === 'cancelled') {
        bottomSection = `
            <div class="mt-4 pt-3 border-t border-[#d2dbbe]">
                <div class="rounded-xl bg-red-50 border border-red-200 p-4">
                    <p class="text-sm text-red-700 font-bold">
                        This appointment has been cancelled.
                    </p>
                    <p class="text-xs text-red-600 mt-1">
                        The clinic has been notified of the cancellation.
                    </p>
                </div>
            </div>
        `;
    }

    // ── Inject into modal ───────────────────────────────────────────────────
    document.getElementById('detail-modal-body').innerHTML = `
        <div class="flex flex-col gap-1 text-[#1a281b]">

            <!-- Title + status badge -->
            <div class="flex items-start justify-between gap-3 mb-1">
                <div>
                    <h3 class="font-extrabold text-xl sm:text-2xl">${service}</h3>
                    <p class="text-sm font-semibold text-gray-600 mt-0.5">Date: ${scheduledDate}</p>
                </div>
                <div style="${style.bg}" class="shrink-0 border-2 border-[#1a281b] rounded-[4px] px-4 py-1 text-center">
                    <span class="font-extrabold text-xs sm:text-sm text-[#1a281b]">${style.text}</span>
                </div>
            </div>

            <!-- Dentist -->
            <p class="text-sm font-semibold mb-2">Dentist: <span class="font-bold">${dentistName}</span></p>

            <!-- Dental Receipt -->
            <p class="font-extrabold text-base border-b-2 border-[#1a281b] pb-1 mb-2">Dental Receipt</p>
            <div class="flex flex-col gap-0.5 text-sm">
                <p>Patient ID: ${patientId}</p>
                <p>Date: ${scheduledDate}</p>
                <p>Number: ${patientPhone}</p>
                <p>Address: ${patientAddress}</p>
                <p>Email: ${patientEmail}</p>
            </div>

            <!-- Pay Now -->
            <div class="mt-3">
                <p class="font-extrabold text-base">Pay Now</p>
                <p class="text-sm">Mode of Payment: ${method}</p>
                <p class="text-sm font-bold">Total: ${amount}</p>
                <p class="text-sm">Payment Status: ${paymentStatus}</p>
            </div>

            <!-- Status-specific bottom -->
            ${bottomSection}
        </div>
    `;

    document.getElementById('detail-modal').classList.remove('hidden');
}

function closeDetailModal() {
    document.getElementById('detail-modal').classList.add('hidden');
}

// ── Cancel Modal logic ──────────────────────────────────────────────────────
function openCancelModal(appointmentId) {
    const cancelModal = document.getElementById('cancel-modal');
    const confirmButton = document.getElementById('confirm-cancel-btn');

    cancelModal.classList.remove('hidden');

    confirmButton.disabled = false;
    confirmButton.textContent = 'Yes, Cancel It';
    confirmButton.classList.remove('opacity-60', 'cursor-not-allowed');

    confirmButton.onclick = () => cancelAppointment(appointmentId);
}

function closeCancelModal() {
    document.getElementById('cancel-modal').classList.add('hidden');
}

async function cancelAppointment(appointmentId) {
    const token = localStorage.getItem('userToken');
    const confirmButton = document.getElementById('confirm-cancel-btn');

    if (!token) {
        alert('Your session has expired. Please log in again.');
        closeCancelModal();
        return;
    }

    if (confirmButton.disabled) {
        return;
    }

    confirmButton.disabled = true;
    confirmButton.textContent = 'Cancelling...';
    confirmButton.classList.add('opacity-60', 'cursor-not-allowed');

    if (TEST_MODE) {
        closeCancelModal();

        const card = document.getElementById(`appt-card-${appointmentId}`);
        if (card) card.remove();

        const appointmentList = document.getElementById('appointment-list');

        if (appointmentList.children.length === 0) {
            appointmentList.innerHTML = '<p class="text-center text-gray-500 py-6 font-bold">No appointments found. Book one today!</p>';
        }

        alert('(TEST MODE) Appointment cancelled. In production, the clinic will be notified.');

        return;
    }

    try {
        const response = await fetch(`/api/appointments/${appointmentId}/cancel`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            closeCancelModal();

            // Reload the list so the cancelled appointment remains in history.
            await fetchAppointments();

            const result = await response.json();

            alert(
                result.message ||
                'Your appointment has been cancelled. The clinic has been notified.'
            );

        } else {
            const err = await response.json();

            alert(
                'Failed to cancel: ' +
                (err.message || 'Please try again.')
            );
        }

    } catch(err) {
        console.error("Cancel error:", err);
        alert('Error cancelling appointment. Please check your connection.');

    } finally {
        confirmButton.disabled = false;
        confirmButton.textContent = 'Yes, Cancel It';
        confirmButton.classList.remove('opacity-60', 'cursor-not-allowed');
    }
}