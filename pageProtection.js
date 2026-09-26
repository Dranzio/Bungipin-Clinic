// DENIED DIRECT PAGE ACCESS VIA URL
(function protectPage() {
    const pagePath = window.location.pathname.toLowerCase();
    const requiredRole = pagePath.startsWith('/admin/')
        ? 'admin'
        : pagePath.startsWith('/employee/')
            ? 'employee'
            : pagePath.startsWith('/customer/')
                ? 'patient'
                : null;
    const loginUrl = `/LogInRegister/login.html?returnUrl=${encodeURIComponent(window.location.pathname)}`;
    const deniedUrl = '/denied.html';

    document.documentElement.style.visibility = 'hidden';

    function redirectToLogin() {
        localStorage.removeItem('userToken');
        window.location.replace(loginUrl);
    }

    async function validatePageAccess() {
        const token = localStorage.getItem('userToken');
        if (!token) {
            redirectToLogin();
            return;
        }

        try {
            const response = await fetch('/api/auth/me', {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (!response.ok) {
                redirectToLogin();
                return;
            }

            const user = await response.json();
            if (requiredRole && user.role !== requiredRole) {
                window.location.replace(deniedUrl);
                return;
            }

            document.documentElement.style.visibility = 'visible';
        } catch (error) {
            redirectToLogin();
        }
    }

    validatePageAccess();
})();