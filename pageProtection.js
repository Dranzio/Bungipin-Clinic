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

    // Runs the same check again, but re-hides the page first so there's no
    // flash of stale content while it re-validates against the server.
    function revalidatePageAccess(reason) {
        console.warn('pageProtection: re-checking access (' + reason + ')');
        document.documentElement.style.visibility = 'hidden';
        validatePageAccess();
    }

    // Case 1: the token changed because a DIFFERENT tab logged in/out.
    // localStorage is shared across tabs on the same origin, so logging in
    // as someone else in another tab silently swaps the token out from
    // under this one. The 'storage' event fires here, in the tab that
    // DIDN'T make the change, the instant that happens.
    window.addEventListener('storage', event => {
        if (event.key !== 'userToken') return;
        revalidatePageAccess('token changed in another tab');
    });

    // Case 2: this page was restored from the back/forward cache (bfcache).
    // Hitting Back after logging in as someone else can bring this exact
    // page back from memory without re-running any of this script's logic
    // at all — 'pageshow' with persisted:true is the one hook that still
    // fires when that happens, so it's the only reliable place to catch it.
    window.addEventListener('pageshow', event => {
        if (event.persisted) {
            revalidatePageAccess('page restored from back/forward cache');
        }
    });

    // Case 3 (belt-and-suspenders): re-check whenever the tab regains
    // focus, in case a 'storage' event was ever missed (some browsers are
    // inconsistent about firing it, e.g. after long background periods).
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            revalidatePageAccess('tab became visible again');
        }
    });

    validatePageAccess();
})();