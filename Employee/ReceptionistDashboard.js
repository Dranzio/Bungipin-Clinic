let currentFilter  = 'all';
let currentSearch  = '';
let currentSort    = 'recent';
let currentPage    = 1;
const rowsPerPage  = 8;
let allAppointments = [];
let filteredAppointments = [];

// Active appointment ID for payment or refund modal
let activePaymentApptId = null;
let activeRefundApptId  = null;

const METHOD_ICONS = {
  cash:     'fa-money-bill-wave',
  card:     'fa-credit-card',
  online:   'fa-mobile-screen-button',
  paymongo: 'fa-mobile-screen-button',
  mongo:    'fa-mobile-screen-button',
};

function formatMethod(method) {
  if (!method) return '—';
  const m = String(method).toLowerCase();
  if (m === 'cash') return 'In-Clinic Cash';
  if (m === 'online' || m === 'paymongo' || m === 'mongo') return 'PayMongo';
  return method.charAt(0).toUpperCase() + method.slice(1);
}

function methodBadge(method) {
  const icon = METHOD_ICONS[method] || 'fa-circle-question';
  return `<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-[#FDFCE9] border border-[#2A1001]/10 text-[#2A1001]">
    <i class="fa-solid ${icon} text-[#667733]"></i>${formatMethod(method)}
  </span>`;
}

// ── Time & Duration Helpers ──
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

// ──────────────────────────────────────────────
//  BOOT
// ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  fetchPayments();
  initFilterControls();
  initPaymentModal();
  initRefundModal();
  initPaymentSocket();
});

function initPaymentSocket() {
  if (typeof io !== 'function') return;
  const socket = io();

  socket.on('payment-confirmed', () => fetchPayments());
  socket.on('appointment-updated', () => fetchPayments());
}

// ──────────────────────────────────────────────
//  FETCH APPOINTMENTS & PAYMENTS
// ──────────────────────────────────────────────
async function fetchPayments() {
  const tbody = document.getElementById('payments-tbody');
  if (tbody && allAppointments.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center p-8 font-bold text-[#667733]"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading payment records...</td></tr>`;
  }

  try {
    const token = localStorage.getItem('token') || localStorage.getItem('userToken');
    const response = await fetch('/api/payments', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    
    allAppointments = await response.json();
    populateDateSortOptions();
    applyFilters();
  } catch (err) {
    console.error('Failed to fetch real data:', err);
    if (tbody) {
      tbody.innerHTML = 
        `<tr><td colspan="5" class="text-center p-8 text-red-500 font-bold">Failed to load payments. Please verify server connection.</td></tr>`;
    }
  }
}

// ──────────────────────────────────────────────
//  FILTER + SEARCH + SORT
// ──────────────────────────────────────────────
function initFilterControls() {
  const searchInput = document.getElementById('search-input');
  const statusFilter = document.getElementById('statusFilter');
  const sortSelect = document.getElementById('sortSelect');

  if (searchInput) {
    searchInput.addEventListener('input', e => {
      currentSearch = e.target.value.toLowerCase().trim();
      currentPage = 1;
      applyFilters();
    });
  }

  if (statusFilter) {
    statusFilter.addEventListener('change', e => {
      currentFilter = e.target.value;
      currentPage = 1;
      applyFilters();
    });
  }

  if (sortSelect) {
    sortSelect.addEventListener('change', e => {
      currentSort = e.target.value;
      currentPage = 1;
      applyFilters();
    });
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

function applyFilters() {
  filteredAppointments = allAppointments.filter(a => {
    const isCancelled = (a.appointment_status || '').toLowerCase() === 'cancelled';
    const paymentStatus = (a.payment_status || '').toLowerCase();

    let matchStatus = false;
    if (currentFilter === 'all') {
      matchStatus = true;
    } else if (currentFilter === 'cancelled') {
      matchStatus = isCancelled && paymentStatus === 'pending';
    } else {
      matchStatus = paymentStatus === currentFilter;
    }

    const name    = `${a.patient_first_name || ''} ${a.patient_last_name || ''}`.toLowerCase();
    const service = (a.service_label || '').toLowerCase();
    const method  = (a.method || '').toLowerCase();
    const matchSearch = !currentSearch || name.includes(currentSearch) || service.includes(currentSearch) || method.includes(currentSearch);
    
    return matchStatus && matchSearch;
  });

  if (currentSort === "recent") {
    filteredAppointments.sort((a, b) => new Date(b.appointment_date).getTime() - new Date(a.appointment_date).getTime());
  } else if (currentSort === "oldest") {
    filteredAppointments.sort((a, b) => new Date(a.appointment_date).getTime() - new Date(b.appointment_date).getTime());
  } else if (currentSort.includes('-')) {
    const [year, monthIndex] = currentSort.split('-').map(Number);
    filteredAppointments = filteredAppointments.filter(a => {
      const d = new Date(a.appointment_date);
      return d.getFullYear() === year && d.getMonth() === monthIndex;
    });
    filteredAppointments.sort((a, b) => new Date(b.appointment_date).getTime() - new Date(a.appointment_date).getTime());
  }

  renderPayments();
}

// ──────────────────────────────────────────────
//  RENDER TABLE
// ──────────────────────────────────────────────
function renderPayments() {
  const tbody      = document.getElementById('payments-tbody');
  const emptyState = document.getElementById('empty-state');
  if (!tbody) return;

  tbody.innerHTML  = '';

  const start = (currentPage - 1) * rowsPerPage;
  const pageItems = filteredAppointments.slice(start, start + rowsPerPage);

  if (pageItems.length === 0) {
    emptyState?.classList.remove('hidden');
  } else {
    emptyState?.classList.add('hidden');
  }

  pageItems.forEach(appt => {
    const scheduledDate = appt.appointment_date
      ? new Date(appt.appointment_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : 'N/A';

    const priceNum = parseFloat(appt.price || appt.amount || 0);
    const isCancelled = (appt.appointment_status || '').toLowerCase() === 'cancelled';
    const paymentStatus = (appt.payment_status || '').toLowerCase();

    // 🏷️ Status Badges
    let statusHtml = '';
    if (isCancelled && paymentStatus === 'pending') {
      statusHtml = `<span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-extrabold bg-red-100 text-red-700 border border-red-300"><span class="w-1.5 h-1.5 rounded-full bg-red-600 mr-1.5"></span>Cancelled</span>`;
    } else if (paymentStatus === 'refund_pending') {
      statusHtml = `<span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-800 border border-blue-300"><span class="w-1.5 h-1.5 rounded-full bg-blue-600 mr-1.5"></span>Requesting Refund</span>`;
    } else if (paymentStatus === 'refunded') {
      statusHtml = `<span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-green-100 text-green-800 border border-green-300"><span class="w-1.5 h-1.5 rounded-full bg-green-600 mr-1.5"></span>Refunded</span>`;
    } else if (paymentStatus === 'paid') {
      statusHtml = `<span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-extrabold bg-[#c2d09c] text-[#1a281b] border border-[#1a281b]/30"><span class="w-1.5 h-1.5 rounded-full bg-[#394a28] mr-1.5"></span>Paid</span>`;
    } else {
      statusHtml = `<span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-extrabold bg-[#F1B770] text-[#2A1001] border border-[#2A1001]/20"><span class="w-1.5 h-1.5 rounded-full bg-[#6a5416] mr-1.5"></span>Pending</span>`;
    }

    // ⚡ Actions Button
    let actionsHtml = '';
    if (paymentStatus === 'pending') {
      if (isCancelled) {
        actionsHtml = `<span class="text-gray-400 italic text-xs font-medium">—</span>`;
      } else {
        actionsHtml = `
          <button onclick="openPaymentModal(${appt.appointment_id})"
            class="h-8 bg-[#667733] hover:bg-[#556022] text-white font-bold px-4 rounded-full text-xs transition active:scale-95 inline-flex items-center justify-center gap-1.5 cursor-pointer shadow-sm whitespace-nowrap">
            <i class="fa-solid fa-check"></i> Accept Payment
          </button>`;
      }
    } else if (paymentStatus === 'refund_pending' || (paymentStatus === 'paid' && !isCancelled)) {
      actionsHtml = `
        <button onclick="openRefundModal(${appt.appointment_id})"
          class="h-8 bg-[#667733] hover:bg-[#556022] text-white font-bold px-4 rounded-full text-xs transition active:scale-95 inline-flex items-center justify-center gap-1.5 cursor-pointer shadow-sm whitespace-nowrap">
          <i class="fa-solid fa-rotate-left"></i> Refund
        </button>`;
    } else {
      actionsHtml = `<span class="text-gray-400 italic text-xs font-medium">—</span>`;
    }

    const tr = document.createElement('tr');
    tr.className = 'hover:bg-[#FDFCE9]/60 transition-colors border-b border-[#2A1001]/10';
    tr.innerHTML = `
      <td class="py-4 px-4 sm:px-6 align-middle">
        <div class="font-extrabold text-[#2A1001] text-sm">${appt.patient_first_name} ${appt.patient_last_name}</div>
        <div class="text-xs text-[#667733] font-bold mt-0.5">${appt.service_label}</div>
      </td>
      <!-- ⏰ Schedule with Full Start & End Time Range -->
      <td class="py-4 px-4 sm:px-6 align-middle">
        <div class="text-[#2A1001] font-bold text-xs sm:text-sm flex items-center gap-1.5">
          <i class="fa-regular fa-calendar text-gray-400 text-xs"></i> ${scheduledDate}
        </div>
        <div class="text-xs text-gray-600 font-extrabold mt-0.5 flex items-center gap-1.5">
          <i class="fa-regular fa-clock text-[#667733] text-[11px]"></i> 
          <span>${getFormattedTimeRange(appt.time_slot, appt.end_time || appt.end_time_slot, appt.service_label)}</span>
        </div>
      </td>
      <td class="py-4 px-4 sm:px-6 align-middle">
        <div class="font-black text-[#2A1001] text-sm mb-1">₱${priceNum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        ${methodBadge(appt.method)}
      </td>
      <td class="py-4 px-4 sm:px-6 text-center align-middle">${statusHtml}</td>
      <td class="py-4 px-4 sm:px-6 text-center align-middle whitespace-nowrap">${actionsHtml}</td>
    `;
    tbody.appendChild(tr);
  });

  renderPagination(filteredAppointments.length);
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
    prevBtn.addEventListener('click', () => { currentPage = batchStart - 1; renderPayments(); });
    pagination.appendChild(prevBtn);
  }

  for (let i = batchStart; i <= batchEnd; i++) {
    const btn = document.createElement('button');
    btn.textContent = i;
    btn.className = `w-9 h-9 rounded-full font-bold text-xs cursor-pointer transition ${i === currentPage ? 'bg-[#667733] text-white shadow-sm' : 'bg-white text-[#2A1001] border border-[#2A1001]/20 hover:bg-gray-50'}`;
    btn.addEventListener('click', () => { currentPage = i; renderPayments(); });
    pagination.appendChild(btn);
  }

  if (batchEnd < totalPages) {
    const nextBtn = document.createElement('button');
    nextBtn.innerHTML = '&rsaquo;';
    nextBtn.className = "w-9 h-9 rounded-full font-bold text-[#2A1001] bg-white border border-[#2A1001]/20 hover:bg-[#2A1001]/10 transition flex items-center justify-center cursor-pointer";
    nextBtn.addEventListener('click', () => { currentPage = batchEnd + 1; renderPayments(); });
    pagination.appendChild(nextBtn);
  }
}

// ──────────────────────────────────────────────
//  1. ACCEPT PAYMENT MODAL (With 12% VAT Breakdown)
// ──────────────────────────────────────────────
function initPaymentModal() {
  const modal      = document.getElementById('paymentModal');
  const closeBtn   = document.getElementById('closeModal');
  const cancelBtn  = document.getElementById('cancelPayBtn');
  const confirmBtn = document.getElementById('confirmPayBtn');
  const doneBtn    = document.getElementById('doneBtn');

  const closeModal = () => {
    modal?.classList.add('hidden');
    document.body.style.overflow = '';
    document.getElementById('paymentForm')?.classList.remove('hidden');
    document.getElementById('paymentSuccess')?.classList.add('hidden');
    activePaymentApptId = null;
  };

  closeBtn?.addEventListener('click', closeModal);
  cancelBtn?.addEventListener('click', closeModal);
  doneBtn?.addEventListener('click', closeModal);
  modal?.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  confirmBtn?.addEventListener('click', () => {
    if (activePaymentApptId == null) return;
    const appt = allAppointments.find(a => a.appointment_id === activePaymentApptId);
    if (appt) processPayment(appt);
  });
}

window.openPaymentModal = function(appointmentId) {
  const appt = allAppointments.find(a => a.appointment_id === appointmentId);
  if (!appt) return;

  activePaymentApptId = appointmentId;

  const totalAmount = parseFloat(appt.price || appt.amount || 0);
  const subtotal = totalAmount / 1.12;
  const vatAmount = totalAmount - subtotal;

  const scheduledDate = appt.appointment_date
    ? new Date(appt.appointment_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'N/A';

  document.getElementById('modal-patient').textContent  = `${appt.patient_first_name} ${appt.patient_last_name}`;
  document.getElementById('modal-service').textContent  = appt.service_label;
  document.getElementById('modal-datetime').textContent = `${scheduledDate} • ${getFormattedTimeRange(appt.time_slot, appt.end_time || appt.end_time_slot, appt.service_label)}`;
  document.getElementById('modal-subtotal').textContent = `₱${subtotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  document.getElementById('modal-vat').textContent      = `₱${vatAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  document.getElementById('modal-amount').textContent   = `₱${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const icon = METHOD_ICONS[appt.method] || 'fa-circle-question';
  document.getElementById('modal-method').innerHTML = `
    <i class="fa-solid ${icon} text-[#667733] text-base"></i>
    <span class="font-extrabold text-sm">${formatMethod(appt.method)}</span>
    <span class="text-xs text-gray-500 font-medium ml-1">(Selected by patient)</span>
  `;

  document.getElementById('paymentForm')?.classList.remove('hidden');
  document.getElementById('paymentSuccess')?.classList.add('hidden');

  document.getElementById('paymentModal')?.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
};

async function processPayment(appt) {
  const confirmBtn = document.getElementById('confirmPayBtn');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> Processing...';
  }

  try {
    const token = localStorage.getItem('token') || localStorage.getItem('userToken');
    const response = await fetch(`/api/payments/${appt.appointment_id}/pay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ amount: appt.price || appt.amount, method: appt.method || 'cash' })
    });

    if (response.ok) {
      appt.payment_status = 'paid';
      showPaymentSuccess(appt);
      applyFilters();
    } else {
      const data = await response.json().catch(() => ({}));
      alert(`Error: ${data.message || 'Failed to accept payment'}`);
    }
  } catch (err) {
    console.error(err);
    alert('Failed to process payment. Please check server connection.');
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = '<i class="fa-solid fa-check"></i> Confirm Payment';
    }
  }
}

function showPaymentSuccess(appt) {
  document.getElementById('paymentForm')?.classList.add('hidden');
  document.getElementById('paymentSuccess')?.classList.remove('hidden');
  const totalAmount = parseFloat(appt.price || appt.amount || 0);
  document.getElementById('success-summary').innerHTML =
    `<strong>₱${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong> successfully recorded from 
     <strong>${appt.patient_first_name} ${appt.patient_last_name}</strong> via 
     <strong>${formatMethod(appt.method)}</strong>.`;
}

// ──────────────────────────────────────────────
//  2. CONFIRM REFUND MODAL
// ──────────────────────────────────────────────
function initRefundModal() {
  const modal      = document.getElementById('refundModal');
  const closeBtn   = document.getElementById('closeRefundModal');
  const cancelBtn  = document.getElementById('cancelRefundBtn');
  const confirmBtn = document.getElementById('confirmRefundSubmitBtn');

  const closeRefundModal = () => {
    modal?.classList.add('hidden');
    document.body.style.overflow = '';
    activeRefundApptId = null;
  };

  closeBtn?.addEventListener('click', closeRefundModal);
  cancelBtn?.addEventListener('click', closeRefundModal);
  modal?.addEventListener('click', e => { if (e.target === modal) closeRefundModal(); });

  confirmBtn?.addEventListener('click', async () => {
    if (activeRefundApptId == null) return;
    const appt = allAppointments.find(a => a.appointment_id === activeRefundApptId);
    if (!appt) return;

    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> Refunding...';

    try {
      const token = localStorage.getItem('token') || localStorage.getItem('userToken');
      const response = await fetch(`/api/payments/${appt.appointment_id}/refund`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ reason: 'Refund processed by receptionist' })
      });

      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        appt.payment_status = data.status || 'refunded';
        closeRefundModal();
        applyFilters();
      } else {
        const data = await response.json().catch(() => ({}));
        alert(`Refund Error: ${data.message || 'Failed to refund'}`);
      }
    } catch (err) {
      console.error(err);
      alert('Failed to process refund. Please try again.');
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = '<i class="fa-solid fa-check"></i> Confirm Refund';
    }
  });
}

window.openRefundModal = function(appointmentId) {
  const appt = allAppointments.find(a => a.appointment_id === appointmentId);
  if (!appt) return;

  activeRefundApptId = appointmentId;

  const totalAmount = parseFloat(appt.price || appt.amount || 0);
  const subtotal = totalAmount / 1.12;
  const vatAmount = totalAmount - subtotal;
  const method = String(appt.method || 'cash').toLowerCase();
  const formattedAmt = `₱${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const expEl = document.getElementById('refund-explanation-text');
  if (expEl) {
    if (method === 'online' || method === 'paymongo' || method === 'mongo') {
      expEl.innerHTML = `
        <div class="flex items-start gap-2.5 bg-blue-50 border border-blue-200 text-blue-900 rounded-2xl p-3 text-xs leading-relaxed">
          <i class="fa-solid fa-mobile-screen-button text-base text-blue-600 mt-0.5 shrink-0"></i>
          <div>
            <strong class="block text-blue-950 font-bold mb-0.5">PayMongo Online Payment</strong>
            <span>Confirming will automatically process a digital refund of <strong>${formattedAmt}</strong> back to the patient's original GCash, Maya, or Card account.</span>
          </div>
        </div>`;
    } else {
      expEl.innerHTML = `
        <div class="flex items-start gap-2.5 bg-amber-50 border border-amber-200 text-amber-900 rounded-2xl p-3 text-xs leading-relaxed">
          <i class="fa-solid fa-money-bill-wave text-base text-amber-700 mt-0.5 shrink-0"></i>
          <div>
            <strong class="block text-amber-950 font-bold mb-0.5">In-Clinic Cash Payment</strong>
            <span>Please physically hand <strong>${formattedAmt}</strong> cash to the patient at the front desk before confirming this refund.</span>
          </div>
        </div>`;
    }
  }

  document.getElementById('refund-modal-patient').textContent  = `${appt.patient_first_name} ${appt.patient_last_name}`;
  document.getElementById('refund-modal-service').textContent  = appt.service_label;
  document.getElementById('refund-modal-subtotal').textContent = `₱${subtotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  document.getElementById('refund-modal-vat').textContent      = `₱${vatAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  document.getElementById('refund-modal-amount').textContent   = formattedAmt;

  document.getElementById('refundModal')?.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
};