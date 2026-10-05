(function () {
    // ---- Settings ---------------------------------------------------------
    // Server-side idle limit is 15 min (IDLE_SECONDS in authMiddleware.js).
    // Warn a bit earlier so the browser always ends the session first.
    const IDLE_LIMIT_MS = 13 * 60 * 1000;
    const COUNTDOWN_SECONDS = 15;
    const PING_EVERY_MS = 2 * 60 * 1000;   // heartbeat while the user is active
    const LOGIN_URL = '/LogInRegister/login.html';

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
    let countdownSeconds = COUNTDOWN_SECONDS;
    let modalOpen = false;
    let lastPing = Date.now();      // the page load itself (/api/auth/me) already counted as activity
    let lastShared = 0;

    const idleModal = document.getElementById('idleModal');
    const countdownDisplay = document.getElementById('countdownTimer');
    const stayLoggedInBtn = document.getElementById('stayLoggedInBtn');

    function startIdleTimer() {
        idleTimeout = setTimeout(showIdleModal, IDLE_LIMIT_MS);
    }

    function resetIdleTimer() {
        clearTimeout(idleTimeout);
        startIdleTimer();
    }

    function showIdleModal() {
        modalOpen = true;
        countdownSeconds = COUNTDOWN_SECONDS;
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
        modalOpen = false;
        clearInterval(countdownInterval);
        idleModal.classList.add('hidden');
        document.body.style.overflow = '';
        resetIdleTimer();
    }

    // Clears browser-side state and goes to the login page.
    function endSessionLocally() {
        localStorage.removeItem('userToken');
        localStorage.removeItem('userRole');
        localStorage.removeItem('userPosition');
        localStorage.removeItem('registrationDraft');
        window.location.replace(LOGIN_URL);
    }

    // Idle logout: tell the server FIRST so the httpOnly cookie is cleared and the
    // session is ended. Clearing localStorage alone leaves the cookie working.
    async function logoutUser() {
        try {
            await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
        } catch (err) {
            // network problem: still log out locally
        }
        endSessionLocally();
    }

    // Heartbeat: keeps the server-side idle clock in step with real activity
    // (typing in a long form makes no API calls). If the server says the session
    // is over (idle, or a newer login on another device), leave immediately.
    async function sendPing() {
        lastPing = Date.now();
        try {
            const res = await fetch('/api/auth/ping', { method: 'POST', credentials: 'same-origin' });
            if (res.status === 401 || res.status === 403 || res.status === 429) {
                endSessionLocally();
            }
        } catch (err) {
            // offline/transient: the next activity will retry
        }
    }

    function onActivity() {
        if (modalOpen) return;            // only the button dismisses the warning
        resetIdleTimer();

        const now = Date.now();
        // Share activity with other open tabs so one busy tab keeps all of them alive.
        if (now - lastShared > 5000) {
            lastShared = now;
            try { localStorage.setItem('lastActivity', String(now)); } catch (e) {}
        }
        if (now - lastPing > PING_EVERY_MS) sendPing();
    }

    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'click'].forEach(evt =>
        window.addEventListener(evt, onActivity, { passive: true })
    );
    window.addEventListener('scroll', onActivity, { passive: true, capture: true });

    // Another tab was active: this tab isn't idle either.
    window.addEventListener('storage', event => {
        if (event.key !== 'lastActivity') return;
        if (modalOpen) hideIdleModal(); else resetIdleTimer();
    });

    stayLoggedInBtn.addEventListener('click', () => {
        hideIdleModal();
        sendPing();
    });

    startIdleTimer();
})();
