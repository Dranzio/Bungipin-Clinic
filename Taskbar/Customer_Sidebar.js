// Customer_Sidebar.js
// Handles: sidebar collapse/expand, user name+email loading
// Called by each Customer page after the sidebar HTML is injected

// IO socket for real-time stuff; connects to window.location.host
const socket = io();
const token = localStorage.getItem('userToken');

// listen for global real-time events
socket.on('connect', () => {
    console.log('socket connected: ', socket.id);
    if (token) {
        socket.emit('authenticate', { token });
    }
});

socket.on('notification', (data) => {
    // update sidebar text dynamically
    const badgeEl = document.getElementById('sidebar-notification-badge');
    if (badgeEl) {
        badgeEl.textContent = data.unreadCount;
        badgeEl.classList.remove('hidden');
    }
});

// exposing socket globally if individual pages need to emit custom events
window.appSocket = socket;

// Helper function to toggle booking link UI state
function updateBookingLinkUI(isComplete) {
    const bookLink = document.querySelector('a[data-page="Booking.html"]');
    let warningText = document.getElementById('profile-warning-text');

    if (!bookLink) return;

    if (isComplete) {
        // Enable link
        bookLink.style.pointerEvents = 'auto';
        bookLink.style.opacity = '1';
        bookLink.href = '../Customer/Booking.html';

        if (warningText) {
            warningText.remove();
        }
    } else {
        // Disable link
        bookLink.style.pointerEvents = 'none';
        bookLink.style.opacity = '0.4';
        bookLink.removeAttribute('href');

        // Inject red warning text if missing
        if (!warningText) {
            warningText = document.createElement('div');
            warningText.id = 'profile-warning-text';
            warningText.className = 'text-red-600 text-[10px] md:text-xs font-medium px-2 md:px-8 text-center md:text-left leading-tight w-full mt-1';
            warningText.innerText = 'Please accomplish your profile first before booking.';
            bookLink.insertAdjacentElement('afterend', warningText);
        }
    }
}

// Real-time listener for profile status changes
if (window.appSocket) {
    window.appSocket.on('profile_status_changed', (data) => {
        console.log('Profile status changed via socket:', data);
        const isComplete = Boolean(data.isComplete || data.birthday);
        updateBookingLinkUI(isComplete);
    });
}

function initSidebar() {
    _loadSidebarUser();
    _initCollapseToggle();
}

// ── Collapse / Expand ────────────────────────────────────────────────────────
function _initCollapseToggle() {
    const toggleBtn = document.getElementById('sidebar-toggle');
    if (!toggleBtn) return;

    // Restore saved state on load (no animation)
    const saved = localStorage.getItem('sidebarCollapsed') === 'true';
    if (saved) _applySidebarState(true);

    toggleBtn.addEventListener('click', () => {
        const isCollapsed = document.getElementById('sidebar').dataset.collapsed === 'true';
        _applySidebarState(!isCollapsed);
        localStorage.setItem('sidebarCollapsed', !isCollapsed);
    });
}

function _clearCollapseStyles(sidebar, aside, nameBadge, profileCircle, labels, navLinks) {
    sidebar.style.width = '';
    if (aside) aside.style.width = '';

    labels.forEach(el => { el.style.display = ''; });
    if (nameBadge) nameBadge.style.display = '';

    if (profileCircle) {
        profileCircle.style.width  = '';
        profileCircle.style.height = '';
    }

    navLinks.forEach(link => {
        link.style.paddingLeft    = '';
        link.style.paddingRight   = '';
        link.style.justifyContent = '';
    });
}

function _applySidebarState(collapse) {
    const sidebar      = document.getElementById('sidebar');
    const aside        = document.getElementById('sidebar-aside');
    const nameBadge    = document.getElementById('name-badge');
    const profileCircle= document.getElementById('profile-circle');
    const labels       = document.querySelectorAll('.sidebar-label');
    const navLinks     = document.querySelectorAll('.nav-link, #sidebar a');

    if (!sidebar) return;

    // Keep the user's desktop preference even when the window is small.
    sidebar.dataset.collapsed = collapse ? 'true' : 'false';
    const isDesktop = window.innerWidth >= 768;

    if (collapse) {
        // ── Collapsed state ─────────────────────────────────────────────────
        if (isDesktop) {
            sidebar.style.width = '72px';
            if (aside) aside.style.width = '72px';
        }

        if (!isDesktop || !collapse) {
            _clearCollapseStyles(sidebar, aside, nameBadge, profileCircle, labels, navLinks);
            return;
        }

        sidebar.style.width = '72px';
        if (aside) aside.style.width = '72px';
        labels.forEach(el => { el.style.display = 'none'; });
        if (nameBadge)     nameBadge.style.display = 'none';

        if (profileCircle) {
            profileCircle.style.width  = '44px';
            profileCircle.style.height = '44px';
        }

        navLinks.forEach(link => {
            link.style.paddingLeft  = '0';
            link.style.paddingRight = '0';
            link.style.justifyContent = 'center';
        });

    } else {
        sidebar.style.width = '';
        if (aside) aside.style.width = '';
        labels.forEach(el => { el.style.display = ''; });
        if (nameBadge)     nameBadge.style.display = '';

        if (profileCircle) {
            profileCircle.style.width  = '';
            profileCircle.style.height = '';
        }

        navLinks.forEach(link => {
            link.style.paddingLeft  = '';
            link.style.paddingRight  = '';
            link.style.justifyContent = '';
        });
    }
}

// Ensure responsive behavior if window is resized
window.addEventListener('resize', () => {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    const isCollapsed = sidebar.dataset.collapsed === 'true';
    _applySidebarState(isCollapsed);
});

// ── Load user name + email from API ─────────────────────────────────────────
async function _loadSidebarUser() {
    const nameEl  = document.getElementById('sidebar-user-name');
    const emailEl = document.getElementById('sidebar-user-email');

    if (!nameEl || !emailEl) return;

    const token = localStorage.getItem('userToken');
    if (!token) return;

    try {
        // Pulls first_name, last_name, email from the users table
        const response = await fetch('/api/patient-profile', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.ok) {
            const data = await response.json();

            nameEl.textContent  = `${data.first_name || ''} ${data.last_name || ''}`.trim() || 'User';
            emailEl.textContent = data.email || '';

            // check if profile is complete
            const isProfileComplete = data.birthday && data.birthday !== '0000-00-00' && data.birthday !== '1970-01-01T00:00:00.000Z';

            // Handle Profile Picture
            const avatarImg = document.getElementById('sidebar-user-avatar');
            const defaultAvatar = document.getElementById('sidebar-default-avatar');
            const picUrl = data.profile_picture || data.image_url; // adjust if your DB uses a different column name

            // lock/unlock booking link and show warning text if not yet complete
            const bookLink = document.querySelector('a[data-page="Booking.html"]');
            let warningText = document.getElementById('profile-warning-text');

            if (bookLink) {
                if (!isProfileComplete) {
                    // disable link
                    bookLink.style.pointerEvents = 'none';
                    bookLink.style.opacity = '0.4';
                    bookLink.removeAttribute('href');

                    // inject tailwind RED WARNENG text below link
                    if (!warningText) {
                        warningText = document.createElement('div');
                        warningText.id = 'profile-warning-text';
                        warningText.className = 'text-red-600 text-[10px] md:text-xs font-medium px-2 md:px-8 text-center md:text-left leading-tight w-full mt-1';
                        warningText.innerText = 'Please accomplish your profile first before booking.';
                        bookLink.insertAdjacentElement('afterend', warningText);
                    }
                } else {
                    // enable link when profile complete
                    bookLink.style.pointerEvents = 'auto';
                    bookLink.style.opacity = '1';
                    bookLink.href = '../Customer/Booking.html';

                    if (warningText) warningText.remove();
                }
            }

            if (avatarImg && defaultAvatar) {
                if (picUrl) {
                    avatarImg.src = picUrl;
                    avatarImg.classList.remove('hidden');
                    defaultAvatar.classList.add('hidden');
                } else {
                    avatarImg.classList.add('hidden');
                    defaultAvatar.classList.remove('hidden');
                }
            }
        } else {
            nameEl.textContent  = 'User';
            emailEl.textContent = '';
        }
    } catch (err) {
        console.error('Sidebar user fetch failed:', err);
        nameEl.textContent  = 'User';
        emailEl.textContent = '';
    }
}