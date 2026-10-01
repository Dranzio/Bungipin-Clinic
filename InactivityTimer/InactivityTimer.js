(function () {
    const modalTimer = `
        <div id="idleModal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4 transition-opacity duration-300">
            <div class="bg-[#F2F0EF] rounded-[30px] w-full max-w-sm flex flex-col items-center justify-center shadow-2xl relative p-8 text-center gap-4">
                <h3 class="text-xl font-bold text-[#2A1001] font-poppins">Are you still there?</h3>
                <p class="text-sm text-[#2A1001] font-poppins">
                    You've been inactive for a while. You will be redirected to the login page in <span id="countdownTimer" class="font-bold text-red-600">15</span> seconds.
                </p>
                <button id="stayLoggedInBtn" class="bg-[#D5C04D] text-[#2A1001] font-bold py-2.5 px-8 rounded-[20px] shadow-md hover:bg-[#e6d057] hover:scale-105 transition-all text-base font-poppins cursor-pointer">
                    Stay Logged In
                </button>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalTimer);

    let idleTimeout;
    let countdownInterval;
    let countdownSeconds = 15;

    const idleModal = document.getElementById('idleModal');
    const countdownDisplay = document.getElementById('countdownTimer');
    const stayLoggedInBtn = document.getElementById('stayLoggedInBtn');

    function startIdleTimer() {
        idleTimeout = setTimeout(showIdleModal, 300000); // 5 minutes for testing
    }

    function resetIdleTimer() {
        clearTimeout(idleTimeout);
        startIdleTimer();
    }

    function showIdleModal() {
        countdownSeconds = 15;
        countdownDisplay.textContent = countdownSeconds;
        idleModal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';

        countdownInterval = setInterval(() => {
            countdownSeconds--;
            countdownDisplay.textContent = countdownSeconds;

            if (countdownSeconds <= 0) {
                clearInterval(countdownInterval);
                logoutUser();
            }
        }, 1000);
    }

    function hideIdleModal() {
        clearInterval(countdownInterval);
        idleModal.classList.add('hidden');
        document.body.style.overflow = '';
        resetIdleTimer();
    }

    function logoutUser() {
        localStorage.removeItem('userToken');
        localStorage.removeItem('registrationDraft');
        window.location.href = '../LoginRegister/login.html'; // Points back to root login page
    }

    window.addEventListener('mousemove', resetIdleTimer);
    window.addEventListener('mousedown', resetIdleTimer);
    window.addEventListener('keypress', resetIdleTimer);
    window.addEventListener('scroll', resetIdleTimer);
    window.addEventListener('touchstart', resetIdleTimer);

    stayLoggedInBtn.addEventListener('click', hideIdleModal);

    startIdleTimer();
})();