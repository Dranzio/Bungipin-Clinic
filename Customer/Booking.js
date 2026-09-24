document.addEventListener('DOMContentLoaded', function () {
    // Calendar rendering only — service selection, time slot selection, the
    // receipt modal, and the actual booking submission all live in the
    // inline <script> in Booking.html. This file used to duplicate all of
    // that too, which caused two separate POST requests per booking.

    const monthYear = document.getElementById('month-year');
    const daysContainer = document.getElementById('days');
    const prevButton = document.getElementById('prev');
    const nextButton = document.getElementById('next');

    const months = [
        'January', 'February', 'March', 'April', 'May', 'June', 'July',
        'August', 'September', 'October', 'November', 'December'
    ];

    let currentDate = new Date();
    let today = new Date();

    function renderCalendar(date) {
        const year = date.getFullYear();
        const month = date.getMonth();
        const firstDay = new Date(year, month, 1).getDay();
        const lastDay = new Date(year, month + 1, 0).getDate();

        monthYear.textContent = `${months[month]} ${year}`;
        daysContainer.innerHTML = '';

        function handleDayClick(dayDiv, sqlDateStr) {
            dayDiv.addEventListener('click', function () {
                document.querySelectorAll('#days > div').forEach(d => {
                    d.classList.remove('bg-[#D7E3A5]', 'border-1', 'border-[#2A1001]');
                });
                dayDiv.classList.add('bg-[#D7E3A5]', 'border-2', 'border-[#2A1001]');

                // This line was missing before — nothing wrote into the hidden
                // input the inline script's submit handler actually reads from,
                // so the selected date silently never made it into the payload.
                document.getElementById('selected-date').value = sqlDateStr;
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