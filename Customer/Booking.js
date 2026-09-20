document.addEventListener('DOMContentLoaded', function () {
    // form elements
    const monthYear = document.getElementById('month-year');
    const daysContainer = document.getElementById('days');
    const prevButton = document.getElementById('prev');
    const nextButton = document.getElementById('next');
    const receiptBox = document.getElementById('receipt-content');

    const months = [
        'January', 'February', 'March', 'April', 'May', 'June', 'July',
        'August', 'September', 'October', 'November', 'December'
    ];

    // Modal elements
    const submitBtn = document.getElementById('submit-btn');
    const modal = document.getElementById('receipt-modal');
    const closeModal = document.getElementById('close-modal');
    const payOnlineBtn = document.getElementById('pay-online-btn');
    const payCashBtn = document.getElementById('pay-cash-btn');
    const qrContainer = document.getElementById('qr-container');

    let currentDate = new Date();
    let today = new Date();

    let selectedDate = null;
    let selectedDateFormatted = null; // Stores YYYY-MM-DD for SQL
    let selectedTime = null;
    let selectedService = null;
    let selectedPrice = 0;
    let customerNote = '';

    function updateReceipt() {
        if (receiptBox) {
            receiptBox.innerHTML = `
                <p><strong>Selected Date: </strong> ${selectedDate || 'None chosen'}</p>
                <p><strong>Selected Time: </strong> ${selectedTime || 'None chosen'}</p>
                <p><strong>Selected Service: </strong> ${selectedService || 'None'}</p>
                <p><strong>Selected Price: </strong> ${selectedPrice ? `Php${selectedPrice}` : ''}</p>
                <p><strong>Note: </strong> ${customerNote || 'None'}</p>
            `;
        }
    }
    
    const noteInput = document.getElementById('PNote');
    if (noteInput) {
        noteInput.addEventListener('input', function () {
            customerNote = noteInput.value.trim();
            updateReceipt();
        });
    }

    const serviceCards = document.querySelectorAll('[data-service]');
    serviceCards.forEach(card => {
        card.addEventListener('click', function () {
            serviceCards.forEach(c => {
                c.classList.remove('bg-[#D7E3A5]');
                c.classList.add('bg-white');
            });

            card.classList.remove('bg-white');
            card.classList.add('bg-[#D7E3A5]');
            
            selectedService = card.getAttribute('data-service');
            selectedPrice = card.getAttribute('data-price');
            updateReceipt();
        });
    });
    
    const timeSlots = document.querySelectorAll('[data-time]');
    timeSlots.forEach(slot => {
        slot.addEventListener('click', function () {
            timeSlots.forEach(s => {
                s.classList.remove('bg-[#D7E3A5]');
                s.classList.add('bg-white');
            });

            slot.classList.remove('bg-white');
            slot.classList.add('bg-[#D7E3A5]');
            
            selectedTime = slot.getAttribute('data-time');
            updateReceipt();
        });
    });

    function renderCalendar(date) {
        const year = date.getFullYear();
        const month = date.getMonth();
        const firstDay = new Date(year, month, 1).getDay();
        const lastDay = new Date(year, month + 1, 0).getDate();

        monthYear.textContent = `${months[month]} ${year}`;
        daysContainer.innerHTML = '';

        function handleDayClick(dayDiv, displayDateStr, sqlDateStr) {
            dayDiv.addEventListener('click', function () {
                document.querySelectorAll('#days > div').forEach(d => {
                    d.classList.remove('bg-[#D7E3A5]', 'border-2', 'border-[#2A1001]');
                });

                dayDiv.classList.add('bg-[#D7E3A5]', 'border-2', 'border-[#2A1001]');

                selectedDate = displayDateStr;
                selectedDateFormatted = sqlDateStr; // YYYY-MM-DD for backend
                updateReceipt();
            })
        }

        const prevMonthLastDay = new Date(year, month, 0).getDate();
        for (let i = firstDay; i > 0; i--) {
            const dayDiv = document.createElement('div');
            dayDiv.classList.add('w-8', 'h-8', 'rounded-full', 'flex', 'items-center', 'justify-center', 'font-medium', 'text-[#fff]', 'cursor-default');
            dayDiv.textContent = prevMonthLastDay - i + 1;
            daysContainer.appendChild(dayDiv);
        }

        for (let i = 1; i <= lastDay; i++){
            const dayDiv = document.createElement('div');
            dayDiv.classList.add(
                'w-8', 'h-8', 'rounded-full', 'flex', 'items-center', 'justify-center',
                'font-medium', 'text-[#2A1001]', 'cursor-pointer', 'transition-colors',
                'hover:bg-[#D7E3A5]', 'hover:rounded-full', 'hover:border-2',
                'hover:border-[#2A1001]', 'hover:scale-[1.25]'
            );

            dayDiv.textContent = i;
            if (i === today.getDate() && month === today.getMonth() && year === today.getFullYear()) {
                dayDiv.classList.add('today');
            }

            const displayStr = `${months[month]} ${i}, ${year}`;
            const formattedMonth = String(month + 1).padStart(2, '0');
            const formattedDay = String(i).padStart(2, '0');
            const sqlStr = `${year}-${formattedMonth}-${formattedDay}`;

            handleDayClick(dayDiv, displayStr, sqlStr);
            daysContainer.appendChild(dayDiv);
        }
    }

    prevButton.addEventListener('click', function () {
        currentDate.setMonth(currentDate.getMonth() - 1);
        renderCalendar(currentDate);
    })

    nextButton.addEventListener('click', function () {
        currentDate.setMonth(currentDate.getMonth() + 1);
        renderCalendar(currentDate);
    })

    submitBtn.addEventListener('click', function () {
        if (!selectedDate || !selectedTime || !selectedService) {
            alert('Please select a Date, Time, and Service before submitting!');
            return;
        }

        updateReceipt();
        modal.classList.remove('hidden');
    });

    closeModal.addEventListener('click', function () {
        modal.classList.add('hidden');
        qrContainer.classList.add('hidden');
    });

    modal.addEventListener('click', function (e) {
        if (e.target === modal) {
            modal.classList.add('hidden');
            qrContainer.classList.add('hidden');
        }
    });

    // Pay Online Button (Shows QR & saves booking as online)
    payOnlineBtn.addEventListener('click', function () {
        qrContainer.classList.toggle('hidden');
        if (!qrContainer.classList.contains('hidden')) {
            sendBookingToDatabase('online');
        }
    });

    // Pay Cash Button (Saves booking as cash)
    payCashBtn.addEventListener('click', function () {
        sendBookingToDatabase('cash');
    });

    // --- Database Submission Function ---
    async function sendBookingToDatabase(paymentMethod) {
        const token = localStorage.getItem('userToken'); // Patient authentication token

        // Map service titles to primary keys matching your SQL `services` table
        const serviceMapping = {
            'Dental Cleaning': 1,
            'Dental Filling': 2,
            'Dental Checkup': 3,
            'Teeth Whitening': 4
        };

        const serviceId = serviceMapping[selectedService] || 1;
        const cleanedPrice = parseFloat(selectedPrice.replace(/,/g, ''));

        // Map time slot format to match database requirements if necessary
        const payload = {
            appointment_date: selectedDateFormatted,
            time_slot: selectedTime, // e.g., "7AM - 8AM" or map to "07:00:00"
            service_id: serviceId,
            patient_note: customerNote || '',
            payment_method: paymentMethod,
            amount: cleanedPrice
        };

        try {
            const response = await fetch('/api/appointments', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(payload)
            });

            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Failed to save appointment');

            if (paymentMethod === 'cash') {
                alert('Cash booking successfully recorded in the database!');
                modal.classList.add('hidden');
                window.location.reload();
            } else {
                console.log('Online payment pending record created.');
            }

        } catch (error) {
            console.error('Database connection error:', error);
            alert('Error saving booking: ' + error.message);
        }
    }

    renderCalendar(currentDate);
});