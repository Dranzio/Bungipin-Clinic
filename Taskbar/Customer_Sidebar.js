// Customer_Sidebar.js
// Handles: sidebar collapse/expand, user name+email loading
// Called by each Customer page after the sidebar HTML is injected

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

        // Hide text labels + name badge
        labels.forEach(el => { el.style.display = 'none'; });
        if (nameBadge)     nameBadge.style.display = 'none';

        // Shrink profile circle
        if (profileCircle) {
            profileCircle.style.width  = '44px';
            profileCircle.style.height = '44px';
        }

        // Center icons in nav links
        navLinks.forEach(link => {
            link.style.paddingLeft  = '0';
            link.style.paddingRight = '0';
            link.style.justifyContent = 'center';
        });

    } else {
        // ── Expanded state ──────────────────────────────────────────────────
        // Remove inline width so Tailwind w-full md:w-[268px] kicks in
        sidebar.style.width = '';
        if (aside) aside.style.width = '';

        // Show text labels + name badge
        labels.forEach(el => { el.style.display = ''; });
        if (nameBadge)     nameBadge.style.display = '';

        // Restore profile circle size
        if (profileCircle) {
            profileCircle.style.width  = '';
            profileCircle.style.height = '';
        }

        // Restore nav link padding
        navLinks.forEach(link => {
            link.style.paddingLeft    = '';
            link.style.paddingRight   = '';
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
    if (!token) {
        nameEl.textContent  = 'Guest';
        emailEl.textContent = '';
        return;
    }

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

            // Handle Profile Picture
            const avatarImg = document.getElementById('sidebar-user-avatar');
            const defaultAvatar = document.getElementById('sidebar-default-avatar');
            const picUrl = data.profile_picture || data.image_url; // adjust if your DB uses a different column name
            
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
