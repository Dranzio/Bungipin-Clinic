(function installPasswordGate() {
    document.documentElement.classList.add('password-gate-pending');

    const MAX_ATTEMPTS = 3;
    let failedAttempts = 0;

    function createGate() {
        const gate = document.createElement('div');
        gate.id = 'password-gate';
        gate.innerHTML = `
            <div class="password-gate-card" role="dialog" aria-modal="true" aria-labelledby="password-gate-title">
                <div class="password-gate-lock" aria-hidden="true">&#128274;</div>
                <h1 id="password-gate-title">Confirm your password</h1>
                <p>Enter your password to access this page.</p>
                <form id="password-gate-form">
                    <label for="password-gate-input">Password</label>
                    <div style="position: relative !important; width: 100% !important; display: block !important; margin: 6px 0 14px 0 !important;">
                        <input id="password-gate-input" type="password" autocomplete="current-password" required 
                               style="width: 100% !important; padding-right: 55px !important; padding-left: 18px !important; text-align: left !important; box-sizing: border-box !important;">
                        <button type="button" id="password-gate-toggle" aria-label="Show Password" 
                                style="position: absolute !important; right: 18px !important; top: 50% !important; transform: translateY(-50%) !important; background: transparent !important; border: none !important; outline: none !important; box-shadow: none !important; width: auto !important; min-width: 0 !important; height: auto !important; padding: 0 !important; margin: 0 !important; cursor: pointer !important; font-size: 13px !important; color: #6b7280 !important; font-weight: 600 !important; font-family: inherit !important; line-height: 1 !important; z-index: 10 !important;">
                            Show
                        </button>
                    </div>
                    <p id="password-gate-error" class="password-gate-error" role="alert"></p>
                    
                    <div style="display: flex; flex-direction: column; gap: 12px; margin-top: 10px;">
                        <button type="submit" style="width: 100%;">Continue</button>
                        <button type="button" id="password-gate-cancel" style="background: transparent; border: none; color: #6b7280; font-size: 13px; font-weight: 600; text-decoration: underline; cursor: pointer; padding: 5px; font-family: inherit;">
                            Cancel and go back
                        </button>
                    </div>
                </form>
            </div>`;
        document.body.appendChild(gate);
        return gate;
    }

    async function initialize() {
        const gate = createGate();
        const form = document.getElementById('password-gate-form');
        const input = document.getElementById('password-gate-input');
        const error = document.getElementById('password-gate-error');
        const submitBtn = form.querySelector('button[type="submit"]');
        const toggleBtn = document.getElementById('password-gate-toggle');
        const cancelBtn = document.getElementById('password-gate-cancel');
        const token = localStorage.getItem('userToken');

        // 🚫 Disable Paste, Copy, Cut, and Drag & Drop
        if (input) {
            ['paste', 'copy', 'cut', 'drop'].forEach(eventType => {
                input.addEventListener(eventType, (e) => e.preventDefault());
            });
        }

        // 👁️ Toggle Show / Hide Password
        if (toggleBtn && input) {
            toggleBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (input.type === 'password') {
                    input.type = 'text';
                    toggleBtn.textContent = 'Hide';
                } else {
                    input.type = 'password';
                    toggleBtn.textContent = 'Show';
                }
                input.focus();
            });
        }

        // 🔙 Cancel / Go Back Logic
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                if (window.history.length > 1) {
                    window.history.back(); // Go back to the previous page
                } else {
                    window.location.replace('/patientRecords.html'); // Fallback route if opened in a new tab
                }
            });
        }

        if (!token) {
            window.location.replace('/LogInRegister/login.html');
            return;
        }

        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (failedAttempts >= MAX_ATTEMPTS) return;

            error.textContent = '';
            submitBtn.disabled = true;
            submitBtn.textContent = 'Checking...';

            try {
                const response = await fetch('/api/auth/reauth', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ password: input.value })
                });
                const result = await response.json();

                if (!response.ok) {
                    failedAttempts++;

                    if (failedAttempts < MAX_ATTEMPTS) {
                        // Regular error without showing count
                        error.textContent = result.error || 'Incorrect password.';
                        input.value = '';
                        input.focus();
                    } else {
                        // 🔒 3 Failed Attempts Reached -> Lock & Force Logout
                        input.disabled = true;
                        submitBtn.disabled = true;
                        if (cancelBtn) cancelBtn.style.display = 'none';
                        if (toggleBtn) toggleBtn.style.display = 'none';
                        error.textContent = 'Too many failed attempts. For your security, you are being logged out...';
                        
                        localStorage.removeItem('userToken');
                        sessionStorage.clear();

                        setTimeout(() => {
                            window.location.replace('/LogInRegister/login.html');
                        }, 2500);
                    }
                    return;
                }

                // Reset failed attempts on success
                failedAttempts = 0;
                document.documentElement.classList.remove('password-gate-pending');
                document.body.classList.remove('password-gated');
                gate.remove();
            } catch (requestError) {
                error.textContent = 'Unable to verify your password. Please check your connection and try again.';
            } finally {
                if (failedAttempts < MAX_ATTEMPTS) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Continue';
                }
            }
        });

        document.body.classList.add('password-gated');
        input.focus();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();