// Admin_Sidebar.js
// Handles: sidebar collapse/expand, admin name+email loading
// Called by each Admin page after the sidebar HTML is injected

function initSidebar() {
    _loadSidebarUser();
    _initCollapseToggle();
}

// ── Collapse / Expand ────────────────────────────────────────────────────────
function _initCollapseToggle() {
    const toggleBtn = document.getElementById('sidebar-toggle');
    if (!toggleBtn) return;

    // Restore saved state on load
    const saved = localStorage.getItem('adminSidebarCollapsed') === 'true';
    if (saved) _applySidebarState(true);

    toggleBtn.addEventListener('click', () => {
        const isCollapsed = document.getElementById('sidebar').dataset.collapsed === 'true';
        _applySidebarState(!isCollapsed);
        localStorage.setItem('adminSidebarCollapsed', !isCollapsed);
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
        if (nameBadge) nameBadge.style.display = 'none';

        if (profileCircle) {
            profileCircle.style.width  = '44px';
            profileCircle.style.height = '44px';
        }

        navLinks.forEach(link => {
            link.style.paddingLeft    = '0';
            link.style.paddingRight   = '0';
            link.style.justifyContent = 'center';
        });
    } else {
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
}

// Responsive behavior on window resize
window.addEventListener('resize', () => {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    const isCollapsed = sidebar.dataset.collapsed === 'true';
    _applySidebarState(isCollapsed);
});

// ── Load admin name + email from API ────────────────────────────────────────
async function _loadSidebarUser() {
    const nameEl  = document.getElementById('sidebar-user-name');
    const emailEl = document.getElementById('sidebar-user-email');
    if (!nameEl || !emailEl) return;

    const token = localStorage.getItem('userToken');
    if (!token) {
        nameEl.textContent  = 'Admin';
        emailEl.textContent = '';
        return;
    }

    try {
        // Pulls first_name, last_name, email from users table (admin role)
        const response = await fetch('/api/admin-profile', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.ok) {
            const data = await response.json();
            nameEl.textContent  = `${data.first_name || ''} ${data.last_name || ''}`.trim() || 'Admin';
            emailEl.textContent = data.email || '';

            // Handle Profile Picture
            const avatarImg     = document.getElementById('sidebar-user-avatar');
            const defaultAvatar = document.getElementById('sidebar-default-avatar');
            const picUrl        = data.profile_picture || data.image_url;

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
            nameEl.textContent  = 'Admin';
            emailEl.textContent = '';
        }
    } catch (err) {
        console.error('Admin sidebar user fetch failed:', err);
        nameEl.textContent  = 'Admin';
        emailEl.textContent = '';
    }
}