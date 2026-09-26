document.addEventListener('DOMContentLoaded', function () {
    // Calendar rendering only — service selection, time slot selection, the
    // receipt modal, and the actual booking submission all live in the
    // inline <script> in Booking.html. This file used to duplicate all of
    // that too, which caused two separate POST requests per booking.

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

    // no past dates
    function isPastDate(dateString) {
        const selectedDay = new Date(`${dateString}T00:00:00`);
        const currentDay = new Date();
        currentDay.setHours(0, 0, 0, 0);
        return selectedDay < currentDay;
    }

    window.updateBookingTimeSlots = function (dateString) {
        const selectedDay = new Date(`${dateString}T00:00:00`);
        const currentTime = new Date();
        const isToday = selectedDay.toDateString() === currentTime.toDateString();

        document.querySelectorAll('[data-time]').forEach(slot => {
            const slotDate = new Date(`${dateString}T${slot.dataset.time}`);
            const unavailable = isToday && slotDate <= currentTime;
            slot.dataset.disabled = unavailable ? 'true' : 'false';
            slot.classList.toggle('bg-gray-200', unavailable);
            slot.classList.toggle('text-gray-400', unavailable);
            slot.classList.toggle('border-gray-300', unavailable);
            slot.classList.toggle('cursor-not-allowed', unavailable);
            slot.classList.toggle('cursor-pointer', !unavailable);
            slot.classList.toggle('hover:bg-[#D7E3A5]', !unavailable);
            slot.classList.toggle('hover:scale-[1.035]', !unavailable);
            slot.setAttribute('aria-disabled', unavailable ? 'true' : 'false');
            // no past dates
            if (unavailable && slot.classList.contains('bg-[#D7E3A5]')) {
                slot.classList.remove('bg-[#D7E3A5]');
                document.getElementById('selected-time').value = '';
            }
        });
    };

    PNote.addEventListener('input', function () {
        const currentLength = PNote.value.length;
        CurrentCount.textContent = currentLength;
    });

    function renderCalendar(date) {
        const year = date.getFullYear();
        const month = date.getMonth();
        const firstDay = new Date(year, month, 1).getDay();
        const lastDay = new Date(year, month + 1, 0).getDate();

        monthYear.textContent = `${months[month]} ${year}`;
        daysContainer.innerHTML = '';

        function handleDayClick(dayDiv, sqlDateStr) {
            // no past dates
            if (isPastDate(sqlDateStr)) return;

            dayDiv.addEventListener('click', function () {
                document.querySelectorAll('#days > div').forEach(d => {
                    d.classList.remove('bg-[#D7E3A5]', 'border-1', 'border-[#2A1001]');
                });
                dayDiv.classList.add('bg-[#D7E3A5]', 'border-2', 'border-[#2A1001]');

                // This line was missing before — nothing wrote into the hidden
                // input the inline script's submit handler actually reads from,
                // so the selected date silently never made it into the payload.
                document.getElementById('selected-date').value = sqlDateStr;
                // no past dates
                window.updateBookingTimeSlots(sqlDateStr);
            });
        }

        const prevMonthLastDay = new Date(year, month, 0).getDate();
        for (let i = firstDay; i > 0; i--) {
            const dayDiv = document.createElement('div');
            dayDiv.classList.add('w-8', 'h-8', 'rounded-full', 'flex', 'items-center', 'justify-center', 'font-medium', 'text-[#fff]', 'cursor-default');
            dayDiv.textContent = prevMonthLastDay - i + 1;
            daysContainer.appendChild(dayDiv);
        }

        for (let i = 1; i <= lastDay; i++) {
            const dayDiv = document.createElement('div');
            dayDiv.classList.add(
                'w-8', 'h-8', 'rounded-full', 'flex', 'items-center', 'justify-center',
                'font-medium', 'text-[#2A1001]', 'cursor-pointer', 'transition-colors',
                'hover:bg-[#D7E3A5]', 'hover:rounded-full', 'hover:border-1',
                'hover:border-[#2A1001]', 'hover:scale-[1.25]'
            );

            dayDiv.textContent = i;
            if (i === today.getDate() && month === today.getMonth() && year === today.getFullYear()) {
                dayDiv.classList.add('today');
            }

            const formattedMonth = String(month + 1).padStart(2, '0');
            const formattedDay = String(i).padStart(2, '0');
            const sqlStr = `${year}-${formattedMonth}-${formattedDay}`;

            // no past dates
            if (isPastDate(sqlStr)) {
                dayDiv.classList.remove('text-[#2A1001]', 'cursor-pointer', 'transition-colors', 'hover:bg-[#D7E3A5]', 'hover:rounded-full', 'hover:border-1', 'hover:border-[#2A1001]', 'hover:scale-[1.25]');
                dayDiv.classList.add('bg-gray-200', 'text-gray-400', 'cursor-not-allowed', 'select-none');
                dayDiv.setAttribute('aria-disabled', 'true');
            }

            handleDayClick(dayDiv, sqlStr);
            daysContainer.appendChild(dayDiv);
        }
    }

    prevButton.addEventListener('click', function () {
        currentDate.setMonth(currentDate.getMonth() - 1);
        renderCalendar(currentDate);
    });

    nextButton.addEventListener('click', function () {
        currentDate.setMonth(currentDate.getMonth() + 1);
        renderCalendar(currentDate);
    });

    renderCalendar(currentDate);
});