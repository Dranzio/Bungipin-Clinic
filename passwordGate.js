(function installPasswordGate() {
    document.documentElement.classList.add('password-gate-pending');

    const MAX_ATTEMPTS = 3;
    let failedAttempts = 0;

    function createGate() {
        const gate = document.createElement('div');
        gate.id = 'password-gate';
        gate.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm z-[99999] flex items-center justify-center p-4 antialiased';
        gate.style.cssText = 'position: fixed !important; inset: 0 !important; background: rgba(0, 0, 0, 0.6) !important; backdrop-filter: blur(4px) !important; z-index: 99999 !important; display: flex !important; align-items: center !important; justify-content: center !important; padding: 16px !important; font-family: "Poppins", sans-serif !important;';
        
        gate.innerHTML = `
            <div class="bg-[#F3EFE4] border border-[#2A1001]/20 rounded-3xl p-6 sm:p-8 max-w-sm w-full shadow-2xl relative text-center flex flex-col items-center gap-3 my-auto" 
                 style="background-color: #F3EFE4 !important; border: 1px solid rgba(42, 16, 1, 0.2) !important; border-radius: 24px !important; padding: 28px 24px !important; max-width: 380px !important; width: 100% !important; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25) !important; text-align: center !important; display: flex !important; flex-direction: column !important; align-items: center !important; gap: 12px !important; box-sizing: border-box !important;"
                 role="dialog" aria-modal="true" aria-labelledby="password-gate-title">
                
                <!-- Lock Icon Wrap -->
                <div class="w-14 h-14 rounded-full bg-[#D7E3A5] text-[#667733] flex items-center justify-center text-2xl shrink-0 shadow-sm"
                     style="width: 56px !important; height: 56px !important; border-radius: 9999px !important; background-color: #D7E3A5 !important; color: #667733 !important; display: flex !important; align-items: center !important; justify-content: center !important; font-size: 22px !important; flex-shrink: 0 !important;">
                    <i class="fa-solid fa-lock"></i>
                </div>

                <div>
                    <h2 id="password-gate-title" style="margin: 0 !important; font-size: 20px !important; font-weight: 800 !important; color: #2A1001 !important; font-family: 'Poppins', sans-serif !important;">
                        Security Verification
                    </h2>
                    <p style="margin: 4px 0 0 0 !important; font-size: 12px !important; color: rgba(42, 16, 1, 0.7) !important; line-height: 1.4 !important; font-weight: 500 !important; font-family: 'Poppins', sans-serif !important;">
                        Please enter your password to access this protected receptionist area.
                    </p>
                </div>

                <form id="password-gate-form" style="width: 100% !important; display: flex !important; flex-direction: column !important; gap: 10px !important; margin-top: 6px !important; box-sizing: border-box !important;">
                    
                    <!-- Standard Design Text Box with Clean Non-Bold Green Show Toggle -->
                    <div style="position: relative !important; width: 100% !important; display: block !important; box-sizing: border-box !important; margin: 4px 0 !important;">
                        <input id="password-gate-input" type="password" autocomplete="current-password" required placeholder="Enter your password..."
                               style="width: 100% !important; min-width: 100% !important; height: 44px !important; padding-left: 18px !important; padding-right: 65px !important; text-align: left !important; border-radius: 9999px !important; border: 1px solid rgba(42, 16, 1, 0.2) !important; background-color: #ffffff !important; outline: none !important; font-size: 13px !important; color: #2A1001 !important; font-family: 'Poppins', sans-serif !important; box-sizing: border-box !important; font-weight: 400 !important; display: block !important; box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05) !important;">
                        
                        <button type="button" id="password-gate-toggle" aria-label="Show Password" 
                                style="position: absolute !important; right: 16px !important; left: auto !important; top: 50% !important; bottom: auto !important; transform: translateY(-50%) !important; background: transparent !important; border: none !important; outline: none !important; cursor: pointer !important; font-size: 13px !important; color: #6b7280 !important; font-weight: 500 !important; font-family: 'Poppins', sans-serif !important; padding: 4px 6px !important; margin: 0 !important; line-height: 1 !important; z-index: 50 !important; display: inline-block !important; width: auto !important; min-width: 0 !important; box-shadow: none !important;">
                            Show
                        </button>
                    </div>

                    <p id="password-gate-error" role="alert" style="margin: 0 !important; font-size: 11px !important; font-weight: 600 !important; color: #dc2626 !important; min-height: 16px !important; font-family: 'Poppins', sans-serif !important;"></p>
                    
                    <div style="display: flex !important; flex-direction: column !important; gap: 8px !important; width: 100% !important; margin-top: 2px !important;">
                        <button type="submit" id="password-gate-submit"
                                style="width: 100% !important; height: 44px !important; background-color: #667733 !important; color: #ffffff !important; font-weight: 700 !important; font-size: 13px !important; border-radius: 9999px !important; border: none !important; cursor: pointer !important; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1) !important; font-family: 'Poppins', sans-serif !important; transition: all 0.2s !important; margin: 0 !important;">
                            Confirm &amp; Continue
                        </button>
                        <button type="button" id="password-gate-cancel" 
                                style="width: 100% !important; height: 40px !important; background-color: #ffffff !important; color: #2A1001 !important; font-weight: 700 !important; font-size: 12px !important; border-radius: 9999px !important; border: 1px solid rgba(42, 16, 1, 0.2) !important; cursor: pointer !important; font-family: 'Poppins', sans-serif !important; transition: all 0.2s !important; margin: 0 !important;">
                            Go Back
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
        const submitBtn = document.getElementById('password-gate-submit');
        const toggleBtn = document.getElementById('password-gate-toggle');
        const cancelBtn = document.getElementById('password-gate-cancel');
        const token = localStorage.getItem('userToken') || localStorage.getItem('token');

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
                    window.history.back();
                } else {
                    window.location.replace('/Customer/History.html');
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
            submitBtn.textContent = 'Verifying...';

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
                        error.textContent = result.error || 'Incorrect password.';
                        input.value = '';
                        input.focus();
                    } else {
                        input.disabled = true;
                        submitBtn.disabled = true;
                        if (cancelBtn) cancelBtn.style.display = 'none';
                        if (toggleBtn) toggleBtn.style.display = 'none';
                        error.textContent = 'Too many failed attempts. Logging out for security...';
                        
                        localStorage.removeItem('userToken');
                        localStorage.removeItem('token');
                        sessionStorage.clear();

                        setTimeout(() => {
                            window.location.replace('/LogInRegister/login.html');
                        }, 2200);
                    }
                    return;
                }

                failedAttempts = 0;
                document.documentElement.classList.remove('password-gate-pending');
                document.body.classList.remove('password-gated');
                gate.remove();
            } catch (requestError) {
                error.textContent = 'Unable to verify password. Please check your connection.';
            } finally {
                if (failedAttempts < MAX_ATTEMPTS) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Confirm & Continue';
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