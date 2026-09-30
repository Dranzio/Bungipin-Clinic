(function installPasswordGate() {
    document.documentElement.classList.add('password-gate-pending');

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
                    <input id="password-gate-input" type="password" autocomplete="current-password" required>
                    <p id="password-gate-error" class="password-gate-error" role="alert"></p>
                    <button type="submit">Continue</button>
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
        const button = form.querySelector('button');
        const token = localStorage.getItem('userToken');

        if (!token) {
            window.location.replace('/LogInRegister/login.html');
            return;
        }

        form.addEventListener('submit', async event => {
            event.preventDefault();
            error.textContent = '';
            button.disabled = true;
            button.textContent = 'Checking...';

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
                    error.textContent = result.error || 'Incorrect password.';
                    input.value = '';
                    input.focus();
                    return;
                }

                document.documentElement.classList.remove('password-gate-pending');
                document.body.classList.remove('password-gated');
                gate.remove();
            } catch (requestError) {
                error.textContent = 'Unable to verify your password. Please try again.';
            } finally {
                button.disabled = false;
                button.textContent = 'Continue';
            }
        });

        document.body.classList.add('password-gated');
        input.focus();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else 
        initialize();
})();
