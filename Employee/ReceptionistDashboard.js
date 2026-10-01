let currentFilter  = 'all';
let currentSearch  = '';
let allAppointments = [];

// Active appointment for the modal
let activeApptId = null;

// ──────────────────────────────────────────────
//  METHOD HELPERS
// ──────────────────────────────────────────────
const METHOD_ICONS = {
  cash:   'fa-money-bill',
  card:   'fa-credit-card',
  online: 'fa-mobile-screen-button',
};

function formatMethod(method) {
  if (!method) return '—';
  return method.charAt(0).toUpperCase() + method.slice(1);
}

function methodBadge(method) {
  const icon = METHOD_ICONS[method] || 'fa-circle-question';
  return `<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-[#FDFCE9] border border-[#D5C04D]/50 text-[#2A1001]">
    <i class="fa-solid ${icon} text-[#D5C04D]"></i>${formatMethod(method)}
  </span>`;
}

// ──────────────────────────────────────────────
//  BOOT
// ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  fetchPayments();
  initFilterTabs();
  initSearch();
  initModal();
});

// ──────────────────────────────────────────────
//  FETCH (with mock fallback)
// ──────────────────────────────────────────────
async function fetchPayments() {
  try {
    const token = localStorage.getItem('token') || localStorage.getItem('userToken');
    const response = await fetch('/api/payments', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    
    allAppointments = await response.json();
    applyFilters();
  } catch (err) {
    console.error('Failed to fetch real data:', err);
    document.getElementById('payments-tbody').innerHTML = 
      `<tr><td colspan="5" class="text-center p-8 text-red-500 font-bold">Failed to load data. Please ensure your backend server is running.</td></tr>`;
  }
}

// ──────────────────────────────────────────────
//  FILTER + SEARCH
// ──────────────────────────────────────────────
function initFilterTabs() {
  const tabs = document.querySelectorAll('.filter-tab');

  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      currentFilter = btn.dataset.filter;
      
      tabs.forEach(b => {
        if (b.dataset.filter === currentFilter) {
          // ACTIVE: Lock scale and opacity, remove hover dependency
          b.classList.add('scale-125', 'opacity-100');
          b.classList.remove('opacity-60', 'hover:scale-125', 'hover:opacity-100');
        } else {
          // INACTIVE: Fade out and restore hover effects
          b.classList.remove('scale-125', 'opacity-100');
          b.classList.add('opacity-60', 'hover:scale-125', 'hover:opacity-100');
        }
      });
      
      applyFilters();
    });
  });
}

function initSearch() {
  document.getElementById('search-input').addEventListener('input', e => {
    currentSearch = e.target.value.toLowerCase().trim();
    applyFilters();
  });
}

function applyFilters() {
  const filtered = allAppointments.filter(a => {
    const matchStatus = currentFilter === 'all' || a.payment_status === currentFilter;
    const name    = `${a.patient_first_name} ${a.patient_last_name}`.toLowerCase();
    const service = (a.service_label || '').toLowerCase();
    const matchSearch = !currentSearch || name.includes(currentSearch) || service.includes(currentSearch);
    return matchStatus && matchSearch;
  });
  renderPayments(filtered);
}

// ──────────────────────────────────────────────
//  RENDER TABLE (Updated Design)
// ──────────────────────────────────────────────
function renderPayments(appointments) {
  const tbody      = document.getElementById('payments-tbody');
  const emptyState = document.getElementById('empty-state');
  tbody.innerHTML  = '';

  if (appointments.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  appointments.forEach(appt => {
    // Format Date & Time
    const date = new Date(appt.appointment_date).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric'
    });
    const [h, m] = appt.time_slot.split(':');
    const timeObj = new Date(); timeObj.setHours(h, m);
    const time = timeObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    // Status Badge Styling (Pill with dot indicator)
    const statusConfig = {
      paid:     { bg: 'bg-[#E5EFD8]', text: 'text-[#4A5D23]', dot: 'text-[#4A5D23]', label: 'Paid' },
      pending:  { bg: 'bg-[#FDECC8]', text: 'text-[#C97B14]', dot: 'text-[#C97B14]', label: 'Pending' },
      refunded: { bg: 'bg-[#FCE4E4]', text: 'text-[#C92A2A]', dot: 'text-[#C92A2A]', label: 'Refunded' }
    };
    const sc = statusConfig[appt.payment_status] || statusConfig.pending;
    const statusHtml = `
      <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ${sc.bg} ${sc.text}">
        <i class="fa-solid fa-circle text-[6px] ${sc.dot}"></i> ${sc.label}
      </span>`;

    // Action Buttons (Confirm Payment / Refund)
    let actionsHtml = '';
    if (appt.payment_status === 'pending') {
      actionsHtml = `
        <button onclick="openPaymentModal(${appt.appointment_id})"
          class="bg-[#D5C04D] hover:bg-[#c2ae3b] text-[#2A1001] font-bold px-4 py-1.5 rounded-full text-xs transition active:scale-95 inline-flex items-center gap-1.5 cursor-pointer shadow-sm">
          <i class="fa-solid fa-check"></i> Confirm Payment
        </button>`;
    } else if (appt.payment_status === 'paid') {
      actionsHtml = `
        <button onclick="refundPayment(${appt.appointment_id})"
          class="bg-[#d8544e] hover:bg-[#d8544e] text-white font-bold px-4 py-1.5 rounded-full text-xs transition active:scale-95 inline-flex items-center gap-1.5 cursor-pointer shadow-sm">
          <i class="fa-solid fa-ban"></i> Refund
        </button>`;
    } else {
      actionsHtml = `<span class="text-gray-400 italic text-xs font-medium">—</span>`;
    }

    // Row Construction
    const tr = document.createElement('tr');
    tr.className = 'border-b border-[#E8ECE1] hover:bg-[#F0F4E8] transition-colors';
    tr.innerHTML = `
      <td class="p-4 whitespace-nowrap">
        <div class="font-bold text-[#2A1001] text-sm">${appt.patient_first_name} ${appt.patient_last_name}</div>
        <div class="text-xs text-[#667733] font-semibold mt-0.5">${appt.service_label}</div>
      </td>
      <td class="p-4 whitespace-nowrap">
        <div class="flex items-center gap-1.5 text-sm text-[#2A1001] mb-1">
          <i class="fa-regular fa-calendar text-[#667733] w-3"></i> ${date}
        </div>
        <div class="flex items-center gap-1.5 text-xs text-gray-500">
          <i class="fa-regular fa-clock text-gray-400 w-3"></i> ${time}
        </div>
      </td>
      <td class="p-4 whitespace-nowrap">
        <div class="font-bold text-[#2A1001] text-sm mb-1">PHP ${parseFloat(appt.price).toFixed(2)}</div>
        ${methodBadge(appt.method)}
      </td>
      <td class="p-4 whitespace-nowrap">${statusHtml}</td>
      <td class="p-4 whitespace-nowrap">${actionsHtml}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ──────────────────────────────────────────────
//  MODAL — INIT
// ──────────────────────────────────────────────

let selectedPaymentMethod = 'cash';

function initModal() {
  const modal      = document.getElementById('paymentModal');
  const closeBtn   = document.getElementById('closeModal');
  const cancelBtn  = document.getElementById('cancelPayBtn');
  const confirmBtn = document.getElementById('confirmPayBtn');
  const doneBtn    = document.getElementById('doneBtn');

  const closeModal = () => {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    document.getElementById('paymentForm').classList.remove('hidden');
    document.getElementById('paymentSuccess').classList.add('hidden');
    activeApptId = null;
  };

  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);
  doneBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  document.querySelectorAll('.method-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const targetBtn = e.currentTarget;
      selectedPaymentMethod = targetBtn.dataset.method;
      
      // Reset all buttons
      document.querySelectorAll('.method-btn').forEach(b => {
        b.classList.remove('border-[#2A1001]', 'bg-[#2A1001]', 'text-white', 'active-method');
        b.classList.add('border-gray-200', 'text-gray-600');
      });
      
      // Highlight the selected button
      targetBtn.classList.remove('border-gray-200', 'text-gray-600');
      targetBtn.classList.add('border-[#2A1001]', 'bg-[#2A1001]', 'text-white', 'active-method');
    });
  });

  confirmBtn.addEventListener('click', () => {
    if (activeApptId == null) return;
    const appt = allAppointments.find(a => a.appointment_id === activeApptId);
    if (appt) processPayment(appt);
  });
}

// ──────────────────────────────────────────────
//  OPEN MODAL
// ──────────────────────────────────────────────
window.openPaymentModal = function(appointmentId) {
  const appt = allAppointments.find(a => a.appointment_id === appointmentId);
  if (!appt) return;

  activeApptId = appointmentId;

  // Populate summary
  document.getElementById('modal-patient').textContent  = `${appt.patient_first_name} ${appt.patient_last_name}`;
  document.getElementById('modal-service').textContent  = appt.service_label;
  document.getElementById('modal-amount').textContent   = `PHP ${parseFloat(appt.price).toFixed(2)}`;

  const date = new Date(appt.appointment_date).toLocaleDateString('en-PH', {
    year: 'numeric', month: 'short', day: 'numeric'
  });
  const [h, m] = appt.time_slot.split(':');
  const timeObj = new Date(); timeObj.setHours(h, m);
  const time = timeObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  document.getElementById('modal-datetime').textContent = `${date} · ${time}`;

  // Show customer's chosen method (read-only)
  const icon = METHOD_ICONS[appt.method] || 'fa-circle-question';
  document.getElementById('modal-method').innerHTML = `
    <i class="fa-solid ${icon} text-[#2A1001] text-lg"></i>
    <span class="font-black text-base">${formatMethod(appt.method)}</span>
    <span class="text-xs text-gray-500 ml-1 font-medium">(Chosen by patient)</span>
  `;

  // Show form, hide success
  document.getElementById('paymentForm').classList.remove('hidden');
  document.getElementById('paymentSuccess').classList.add('hidden');

  document.getElementById('paymentModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
};

// ──────────────────────────────────────────────
//  PROCESS PAYMENT
// ──────────────────────────────────────────────
async function processPayment(appt) {
  if (usingMockData) {
    appt.payment_status = 'paid';
    showPaymentSuccess(appt);
    applyFilters();
    return;
  }

  try {
    const token = localStorage.getItem('token') || localStorage.getItem('userToken');
    const response = await fetch(`/api/payments/${appt.appointment_id}/pay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      // Uses the method already tied to the appointment from the database
      body: JSON.stringify({ amount: appt.price, method: appt.method })
    });

    if (response.ok) {
      appt.payment_status = 'paid';
      showPaymentSuccess(appt);
      applyFilters();
    } else {
      const data = await response.json();
      alert(`Error: ${data.message}`);
    }
  } catch (err) {
    console.error(err);
    alert('Failed to process payment. Please try again.');
  }
}

function showPaymentSuccess(appt) {
  document.getElementById('paymentForm').classList.add('hidden');
  document.getElementById('paymentSuccess').classList.remove('hidden');
  document.getElementById('success-summary').innerHTML =
    `<strong>PHP ${parseFloat(appt.price).toFixed(2)}</strong> received from 
     <strong>${appt.patient_first_name} ${appt.patient_last_name}</strong> via 
     <strong>${formatMethod(appt.method)}</strong>.`;
}

// ──────────────────────────────────────────────
//  REFUND
// ──────────────────────────────────────────────
window.refundPayment = async function(appointmentId) {
  if (!confirm('Are you sure you want to refund this payment?')) return;

  const appt = allAppointments.find(a => a.appointment_id === appointmentId);
  if (!appt) return;

  if (usingMockData) {
    appt.payment_status = 'refunded';
    applyFilters();
    return;
  }

  try {
    const token = localStorage.getItem('token') || localStorage.getItem('userToken');
    const response = await fetch(`/api/payments/${appointmentId}/refund`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (response.ok) {
      appt.payment_status = 'refunded';
      applyFilters();
    } else {
      const data = await response.json();
      alert(`Error: ${data.message}`);
    }
  } catch (err) {
    console.error(err);
    alert('Failed to refund payment. Please try again.');
  }
};
