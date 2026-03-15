// --- Global Utils ---
const toGB = (bytes) => {
    const n = typeof bytes === 'string' ? Number(bytes) : Number(bytes ?? 0);
    const safe = Number.isFinite(n) ? n : 0;
    return (safe / (1024 ** 3)).toFixed(2);
};

function formatGB(gb) {
    const n = Number(gb);
    if (!Number.isFinite(n)) return { value: '0.00', unit: 'GB' };
    if (n >= 1024) return { value: (n / 1024).toFixed(2), unit: 'TB' };
    return { value: n.toFixed(2), unit: 'GB' };
}

function setTextSafe(selOrEl, text) {
    try {
        const el = typeof selOrEl === 'string' ? document.querySelector(selOrEl) : selOrEl;
        if (el) el.textContent = String(text);
    } catch(e) {}
}

function animateNumber(elOrSelector, to, opts = {}) {
    const duration = Number(opts.duration ?? 800);
    const decimals = Number(opts.decimals ?? 2);
    const from = Number(opts.from ?? null);
    const formatter = typeof opts.formatter === 'function'
        ? opts.formatter
        : (v) => Number(v).toFixed(decimals);

    const el = typeof elOrSelector === 'string' ? document.querySelector(elOrSelector) : elOrSelector;
    if (!el) return;

    let startVal = Number.isFinite(from) ? from : Number(el.textContent);
    if (!Number.isFinite(startVal)) startVal = 0;
    const endVal = Number(to);
    if (!Number.isFinite(endVal)) {
        el.textContent = formatter(0);
        return;
    }

    // Prefer GSAP core, else anime.js
    try {
        if (typeof gsap !== 'undefined') {
            const obj = { v: startVal };
            gsap.to(obj, {
                v: endVal,
                duration: duration / 1000,
                ease: 'power2.out',
                onUpdate: () => { el.textContent = formatter(obj.v); }
            });
            return;
        }
    } catch(e) {}

    try {
        if (typeof anime !== 'undefined') {
            const obj = { v: startVal };
            anime({
                targets: obj,
                v: endVal,
                duration,
                easing: 'easeOutCubic',
                update: () => { el.textContent = formatter(obj.v); }
            });
            return;
        }
    } catch(e) {}

    el.textContent = formatter(endVal);
}

let currentRole = null;
let adminToken = null;
let loopInterval = null;
let clientLoopInterval = null; // legacy polling (kept as fallback)
let __clientLast = null; // { downBytes, upBytes, ts }
let __clientEventSource = null;
let __clientSseRetry = null;

// Background (Vanta)
let __vanta = null;

// Client list cache (for search + drawer)
let __clientsCache = [];
let __clientSearchTerm = '';

function stopClientSSE() {
    try { __clientEventSource?.close?.(); } catch(e) {}
    __clientEventSource = null;
    try { clearInterval(__clientSseRetry); } catch(e) {}
    __clientSseRetry = null;
}

function startClientSSE(idToCheck) {
    stopClientSSE();
    if (!idToCheck) return;

    const es = new EventSource(`/public/stream?id=${encodeURIComponent(idToCheck)}`);
    __clientEventSource = es;

    es.addEventListener('client', (ev) => {
        try {
            const c = JSON.parse(ev.data || '{}');
            if (c && (c.email || c.down !== undefined)) {
                applyClientDataToUI(c);
            }
        } catch(e) {}
    });

    es.addEventListener('notfound', () => {
        // stop to avoid infinite reconnect spam
        stopClientSSE();
        showToast('User not found', 'error');
    });

    es.addEventListener('error', () => {
        try { es.close(); } catch(e) {}
        __clientEventSource = null;
        if (__clientSseRetry) return;
        __clientSseRetry = setInterval(() => {
            try { clearInterval(__clientSseRetry); } catch(e) {}
            __clientSseRetry = null;
            startClientSSE(idToCheck);
        }, 1500);
    });
}

function doLogout() {
    try { stopAdminSSE(); } catch(e) {}
    try { stopClientSSE(); } catch(e) {}
    try { clearInterval(loopInterval); } catch(e) {}
    try { clearInterval(clientLoopInterval); } catch(e) {}
    loopInterval = null;
    clientLoopInterval = null;
    __clientLast = null;
    currentRole = null;
    adminToken = null;
    try { sessionStorage.removeItem('xui_admin_token'); } catch(e) {}

    // Reset UI
    document.getElementById('login-overlay').style.display = 'flex';
    try { document.querySelector('.desktop-nav')?.style && (document.querySelector('.desktop-nav').style.display = 'none'); } catch(e) {}
    try { document.querySelector('.mobile-nav')?.style && (document.querySelector('.mobile-nav').style.display = 'none'); } catch(e) {}
    document.getElementById('main-fab').style.display = 'none';

    // restore default tab (client) UI
    try { document.getElementById('tab-login-client').click(); } catch(e) {}
}

// Logout button (header)
document.addEventListener('click', (e) => {
    if (e.target && (e.target.id === 'btn-logout' || e.target.closest('#btn-logout'))) {
        doLogout();
    }

    // Micro interaction: button press
    try {
        const btn = e.target?.closest?.('button');
        if (btn && typeof gsap !== 'undefined') {
            gsap.fromTo(btn, { scale: 0.98 }, { scale: 1, duration: 0.14, ease: 'power2.out' });
        } else if (btn && typeof anime !== 'undefined') {
            anime({ targets: btn, scale: [0.98, 1], duration: 160, easing: 'easeOutCubic' });
        }
    } catch(err) {}
});

function showToast(msg, type="info") {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.style.borderColor = type === 'error' ? 'var(--red)' : 'var(--accent)';
    toast.innerHTML = `<i class="fa-solid fa-bell"></i> <span>${msg}</span>`;
    container.appendChild(toast);

    // GSAP toast animation (fallback to CSS)
    try {
        if (typeof gsap !== 'undefined') {
            gsap.fromTo(toast, { y: 10, opacity: 0 }, { y: 0, opacity: 1, duration: 0.2, ease: 'power2.out' });
        }
    } catch(e) {}

    setTimeout(() => {
        try {
            if (typeof gsap !== 'undefined') {
                gsap.to(toast, { opacity: 0, y: -8, duration: 0.18, ease: 'power2.in', onComplete: () => toast.remove() });
                return;
            }
        } catch(e) {}
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// --- Login / Auth UI Logic ---
document.getElementById('tab-login-admin').addEventListener('click', (e) => {
    e.target.style.color = 'var(--accent)'; e.target.style.borderBottomColor = 'var(--accent)';
    document.getElementById('tab-login-client').style.color = 'var(--text-dim)'; document.getElementById('tab-login-client').style.borderBottomColor = 'transparent';
    document.getElementById('login-form-admin').style.display = 'block';
    document.getElementById('login-form-client').style.display = 'none';
});
document.getElementById('tab-login-client').addEventListener('click', (e) => {
    e.target.style.color = 'var(--accent)'; e.target.style.borderBottomColor = 'var(--accent)';
    document.getElementById('tab-login-admin').style.color = 'var(--text-dim)'; document.getElementById('tab-login-admin').style.borderBottomColor = 'transparent';
    document.getElementById('login-form-admin').style.display = 'none';
    document.getElementById('login-form-client').style.display = 'block';
});

// Default tab selection is handled on DOMContentLoaded using cached last tab.

document.getElementById('btn-login-admin').addEventListener('click', async () => {
    // Cloudflare Access needs a top-level navigation to perform the Google redirect.
    // A fetch() will not show the login UI.
    try { localStorage.setItem('xui_last_tab', 'admin'); } catch(e) {}
    window.location.href = '/api/status';
});

document.getElementById('btn-login-client').addEventListener('click', async () => {
    const id = (document.getElementById('login-email').value || '').trim();
    const btn = document.getElementById('btn-login-client');
    btn.textContent = "Checking...";

    if (!id) {
        showToast('Enter your email/ID', 'error');
        btn.textContent = "Check Traffic";
        return;
    }

    // cache last client id + last tab
    try {
        localStorage.setItem('xui_last_tab', 'client');
        localStorage.setItem('xui_client_id', id || '');
    } catch(e) {}

    try {
        const res = await fetch('/public/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'client', id })
        });

        const ct = res.headers.get('Content-Type') || '';
        if (!ct.includes('application/json')) {
            // This happens sometimes when Cloudflare/edge returns HTML (blocked/expired) or a 502 page.
            const txt = await res.text().catch(()=> '');
            console.warn('Client auth non-JSON response:', res.status, txt.slice(0, 200));
            showToast(res.status === 401 ? 'Session expired. Refresh and try again.' : 'Server temporary issue. Try again.', 'error');
            btn.textContent = "Check Traffic";
            return;
        }

        const data = await res.json();
        if (data && data.success) {
            currentRole = 'client';
            startClientApp(data.clientData);
        } else {
            showToast((data && data.msg) || 'User not found', 'error');
        }
    } catch(e) {
        console.warn('Client auth error:', e);
        showToast('Network/Server error. Try again.', 'error');
    }
    btn.textContent = "Check Traffic";
});


// Activate specific Dashboard
async function startAdminApp() {
    document.getElementById('login-overlay').style.display = 'none';
    // show logout
    try { document.getElementById('btn-logout').style.display = 'inline-flex'; } catch(e) {}
    document.getElementById('tab-user-view').style.display = 'none';

    // Admin top tabs removed (desktop-nav/mobile-nav)
    try { document.querySelector('.desktop-nav')?.style && (document.querySelector('.desktop-nav').style.display = 'none'); } catch(e) {}
    try { document.querySelector('.mobile-nav')?.style && (document.querySelector('.mobile-nav').style.display = 'none'); } catch(e) {}
    document.getElementById('main-fab').style.display = 'flex';

    // Show admin select nav
    try {
        const sel = document.getElementById('admin-tab-select');
        if (sel) sel.style.display = 'inline-flex';
        if (sel && sel.value) switchTab(sel.value);
        else switchTab('overview');
    } catch(e) {
        switchTab('overview');
    }

    initAdminCharts();
    await loadAdminData();

    // Hero + cards intro + scroll reveals
    try {
        // NOTE: there are two .data-card-hero cards (client + admin). Target the admin one.
        const hero = document.querySelector('#tab-overview .data-card-hero');
        if (typeof gsap !== 'undefined') {
            if (hero) {
                gsap.fromTo(hero, { opacity: 0, y: 18, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: 'power2.out' });
                // subtle glow pulse
                gsap.fromTo(hero, { boxShadow: '0 0 0 rgba(0,255,204,0)' }, { boxShadow: '0 0 34px rgba(0,255,204,0.14)', duration: 0.8, yoyo: true, repeat: 1, ease: 'sine.inOut' });
            }

            gsap.from('.resource-card, .card:not(.data-card-hero)', { opacity: 0, y: 12, duration: 0.35, stagger: 0.02, ease: 'power2.out', delay: 0.05 });

            if (typeof ScrollTrigger !== 'undefined') {
                gsap.registerPlugin(ScrollTrigger);
                gsap.utils.toArray('.card, .item-card').forEach((el) => {
                    gsap.fromTo(el,
                        { opacity: 0, y: 18 },
                        {
                            opacity: 1,
                            y: 0,
                            duration: 0.5,
                            ease: 'power2.out',
                            scrollTrigger: {
                                trigger: el,
                                start: 'top 85%',
                                toggleActions: 'play none none reverse'
                            }
                        }
                    );
                });
            }
        } else if (typeof anime !== 'undefined') {
            if (hero) {
                anime({ targets: hero, opacity: [0,1], translateY: [18,0], scale: [0.98,1], duration: 520, easing: 'easeOutCubic' });
            }
            const cards = document.querySelectorAll('.card, .item-card');
            anime({ targets: cards, opacity: [0,1], translateY: [14,0], delay: anime.stagger(20), duration: 380, easing: 'easeOutCubic' });
        }
    } catch(e) {}

    // Heavy refresh (inbounds/clients/history) stays slower to avoid hammering the panel.
    loopInterval = setInterval(loadAdminData, 60000);

    // Lightweight near-realtime updates via SSE (updates status/traffic/cpu/ram without 4x polling)
    try { startAdminSSE(); } catch(e) {}

    // load settings
    fetch('/api/settings').then(r=>r.json()).then(set=>{
        if(set && set.panelUrl) {
            document.getElementById("setting-url").value = set.panelUrl;
            document.getElementById("setting-user").value = set.username || "";
            document.getElementById("setting-pass").value = set.password || "";
        }
    }).catch(()=>{});
}

function updateClientSpeedsFromDelta(nowDown, nowUp) {
    try {
        const now = Date.now();
        if (!__clientLast) {
            __clientLast = { downBytes: Number(nowDown)||0, upBytes: Number(nowUp)||0, ts: now };
            setTextSafe('#user-dl-speed', '0');
            setTextSafe('#user-up-speed', '0');
            return;
        }
        const dt = (now - __clientLast.ts) / 1000;
        if (dt <= 0) return;
        const dDown = (Number(nowDown)||0) - (__clientLast.downBytes||0);
        const dUp = (Number(nowUp)||0) - (__clientLast.upBytes||0);

        // Mbps
        const downMbps = Math.max(0, (dDown * 8) / (dt * 1e6));
        const upMbps = Math.max(0, (dUp * 8) / (dt * 1e6));

        animateNumber('#user-dl-speed', downMbps, { decimals: 2, duration: 500 });
        animateNumber('#user-up-speed', upMbps, { decimals: 2, duration: 500 });

        __clientLast = { downBytes: Number(nowDown)||0, upBytes: Number(nowUp)||0, ts: now };
    } catch(e) {}
}

function applyClientDataToUI(client) {
    if (!client) return;

    // compute speed (based on delta bytes between refreshes)
    updateClientSpeedsFromDelta(client.down, client.up);

    const down = parseFloat(toGB(client.down));
    const up = parseFloat(toGB(client.up));
    const totalUsed = (down + up).toFixed(2);
    const limit = parseFloat(toGB(client.total));
    const remainDesc = limit === 0 ? "Unlimited GB" : `${limit.toFixed(2)} GB`;

    // Extra details (if present)
    const fmtTime = (ms) => {
        const n = Number(ms);
        if (!Number.isFinite(n) || n <= 0) return '-';
        return new Date(n).toLocaleString();
    };

    try {
        // Keep the server pill intact; only replace content when in client mode
        if (client.email) {
            const us = document.querySelector('.user-status');
            if (us) us.innerHTML = '<span>Hi, <strong style="color:var(--accent)">'+client.email+'</strong></span>';
        }
        document.getElementById('user-email').textContent = client.email || document.getElementById('user-email').textContent || '-';
        if (client.uuid !== undefined) document.getElementById('user-uuid').textContent = client.uuid || '-';
        if (client.subId !== undefined) document.getElementById('user-subid').textContent = client.subId || '-';
        if (client.lastOnline !== undefined) document.getElementById('user-last-online').textContent = fmtTime(client.lastOnline);
    } catch(e) {}

    // counters
    animateNumber('#user-used', Number(totalUsed), { decimals: 2, duration: 500 });
    animateNumber('#user-dl', Number(down), { decimals: 2, duration: 500 });
    animateNumber('#user-up', Number(up), { decimals: 2, duration: 500 });
    setTextSafe('#user-total', remainDesc);

    // Subscription Snapshot (unique UI)
    try {
        const usedGB = Number(totalUsed);
        const limitGB = Number(limit);
        const remainingGB = (limitGB > 0) ? Math.max(0, limitGB - usedGB) : NaN;

        const usedFmt = formatGB(usedGB);
        const remainFmt = (limitGB > 0) ? formatGB(remainingGB) : null;
        const limitFmt = (limitGB > 0) ? formatGB(limitGB) : null;

        setTextSafe('#sub-used', usedFmt.value);
        setTextSafe('#sub-used-unit', usedFmt.unit);
        setTextSafe('#sub-lifetime', `${usedFmt.value} ${usedFmt.unit}`);

        setTextSafe('#sub-remaining', (limitGB > 0 && remainFmt) ? `${remainFmt.value} ${remainFmt.unit}` : 'Unlimited');
        setTextSafe('#sub-limit', (limitGB > 0 && limitFmt) ? `${limitFmt.value} ${limitFmt.unit}` : 'Unlimited');

        // expiry
        const exp = Number(client.expiryTime ?? client.expiry ?? 0);
        const expText = (!Number.isFinite(exp) || exp <= 0) ? 'Never' : new Date(exp).toLocaleString();
        setTextSafe('#sub-expiry', expText);

        // account status
        const active = client.enable !== false;
        setTextSafe('#sub-account', active ? 'Active' : 'Disabled/Expired');

        // status pill (snapshot)
        const dot = document.getElementById('sub-status-dot');
        const pill = document.getElementById('sub-status-pill');
        const st = document.getElementById('sub-status-text');
        if (dot && st && pill) {
            if (active) {
                st.textContent = 'ACTIVE';
                dot.style.background = 'var(--green)';
                dot.style.boxShadow = '0 0 0 4px rgba(0,255,102,0.15)';
            } else {
                st.textContent = 'INACTIVE';
                dot.style.background = 'var(--red)';
                dot.style.boxShadow = '0 0 0 4px rgba(255,51,51,0.16)';
            }
        }

        // status pill (top header)
        try {
            const top = document.getElementById('client-top-status');
            const topDot = document.getElementById('client-top-dot');
            const topText = document.getElementById('client-top-text');
            if (top && topDot && topText) {
                top.style.display = 'inline-flex';
                if (active) {
                    topText.textContent = 'ACTIVE';
                    topDot.style.background = 'var(--green)';
                    topDot.style.boxShadow = '0 0 0 4px rgba(0,255,102,0.15)';
                } else {
                    topText.textContent = 'INACTIVE';
                    topDot.style.background = 'var(--red)';
                    topDot.style.boxShadow = '0 0 0 4px rgba(255,51,51,0.16)';
                }
            }
        } catch(e) {}

        // gauge
        const frac = (limitGB > 0) ? Math.max(0, Math.min(1, usedGB / limitGB)) : 0;
        const pct = (frac * 100);
        const gauge = document.getElementById('sub-gauge');
        if (gauge) gauge.style.setProperty('--p', String(frac));
        setTextSafe('#sub-gauge-pct', limitGB > 0 ? `${pct.toFixed(1)}%` : '∞');
    } catch(e) {}

    try {
        if (client.enable === false) {
            document.getElementById('user-status-text').innerText = "Disabled or Expired";
            document.getElementById('user-status-text').classList.remove('active');
            document.getElementById('user-status-text').style.color = "var(--red)";
        } else {
            document.getElementById('user-status-text').innerText = "Active";
            document.getElementById('user-status-text').classList.add('active');
            document.getElementById('user-status-text').style.color = "";
        }
    } catch(e) {}

    // Progress bar (animated)
    try {
        const bar = document.getElementById('user-progress');
        if (bar) {
            // restart CSS animation
            bar.classList.remove('anim');
            // force reflow
            void bar.offsetWidth;
            bar.classList.add('anim');

            if (limit > 0) {
                let pct = (Number(totalUsed) / limit) * 100;
                if (pct > 100) pct = 100;
                if (typeof gsap !== 'undefined') gsap.to(bar, { width: `${pct}%`, duration: 0.55, ease: 'power2.out' });
                else if (typeof anime !== 'undefined') anime({ targets: bar, width: `${pct}%`, duration: 550, easing: 'easeOutCubic' });
                else bar.style.width = `${pct}%`;
            } else {
                bar.style.width = '100%';
            }
        }
    } catch(e) {}

    // Donut update/create
    try {
        if (typeof Chart !== 'undefined') {
            const donutCanvas = document.getElementById('userDonut');
            const donutCtx = donutCanvas?.getContext?.('2d');
            if (donutCtx) {
                if (window.__userDonut && window.__userDonut.data?.datasets?.[0]) {
                    window.__userDonut.data.datasets[0].data = [down, up];
                    window.__userDonut.update();
                } else {
                    window.__userDonut = new Chart(donutCtx, {
                        type: 'doughnut',
                        data: { datasets: [{ data: [down, up], backgroundColor: ['#0066ff', '#00ffcc'], borderWidth: 0 }] },
                        options: { cutout: '80%', plugins: { tooltip: { enabled: false } } }
                    });
                }
            }
        }
    } catch(e) {}
}

function startClientApp(client) {
    document.getElementById('login-overlay').style.display = 'none';
    // show logout
    try { document.getElementById('btn-logout').style.display = 'inline-flex'; } catch(e) {}

    // Hide admin select nav
    try { const sel = document.getElementById('admin-tab-select'); if (sel) sel.style.display = 'none'; } catch(e) {}

    // Hide Admin Navigation completely (nav removed from HTML)
    try { document.querySelector('.desktop-nav')?.style && (document.querySelector('.desktop-nav').style.display = 'none'); } catch(e) {}
    try { document.querySelector('.mobile-nav')?.style && (document.querySelector('.mobile-nav').style.display = 'none'); } catch(e) {}
    document.getElementById('main-fab').style.display = 'none';

    // Hide all tabs except user view
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.getElementById('tab-user-view').classList.add('active');

    // first paint
    applyClientDataToUI(client);

    // Start SSE for near-realtime updates (preferred)
    try {
        const idToCheck = (localStorage.getItem('xui_client_id') || client.email || '').trim();
        startClientSSE(idToCheck);
    } catch(e) {}

    // Fallback polling (very slow) if SSE fails completely
    try { clearInterval(clientLoopInterval); } catch(e) {}
    clientLoopInterval = null;
    try {
        const idToCheck = (localStorage.getItem('xui_client_id') || client.email || '').trim();
        if (idToCheck) {
            clientLoopInterval = setInterval(() => {
                fetch('/public/auth', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: 'client', id: idToCheck })
                })
                .then(r => r.json())
                .then(d => { if (d && d.success) applyClientDataToUI(d.clientData); })
                .catch(()=>{});
            }, 120000);
        }
    } catch(e) {}
}

// --- Admin Helper Functions ---
function getAdminHeaders() {
    // When protected by Cloudflare Access, backend authorizes via identity header.
    // In that case, DO NOT send Bearer password.
    if (!adminToken || adminToken === 'zero-trust-secured') {
        return { 'Content-Type': 'application/json' };
    }
    return { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
}

window.triggerAction = (action) => {
    showToast(`${action}...`);
    setTimeout(() => { showToast(`${action} Triggered`); loadAdminData(); }, 1000);
};

function closeModal() { document.getElementById('modal-overlay').classList.remove('active'); }
document.getElementById('main-fab').addEventListener('click', () => {
    const m = document.getElementById('modal-overlay');
    m.classList.add('active');
    try {
        const card = m.querySelector('.modal-card');
        if (!card) return;

        if (typeof gsap !== 'undefined') {
            gsap.fromTo(card, { opacity: 0, y: 22, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.26, ease: 'power2.out' });
        }
    } catch(e) {}
});

function isMobileLike() {
    try { return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 768; } catch(e) { return false; }
}

function prefersReducedMotion() {
    try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch(e) { return false; }
}

function startVantaGlobe() {
    try {
        const el = document.getElementById('vanta-bg');
        if (!el) return;
        if (prefersReducedMotion()) return;
        if (typeof VANTA === 'undefined' || !VANTA.GLOBE) return;

        // destroy previous
        try { __vanta?.destroy?.(); } catch(e) {}

        const mobile = isMobileLike();
        __vanta = VANTA.GLOBE({
            el,
            mouseControls: !mobile,
            touchControls: true,
            gyroControls: false,
            minHeight: 200.00,
            minWidth: 200.00,
            scale: mobile ? 0.8 : 1.0,
            scaleMobile: 0.75,
            color: 0x00ffcc,
            color2: 0x0066ff,
            backgroundColor: 0x000000,
            size: mobile ? 0.55 : 0.75
        });

        el.classList.add('active');
        try { localStorage.setItem('xui_bg', 'on'); } catch(e) {}
    } catch(e) {
        console.warn('Vanta init failed', e);
    }
}

function stopVantaGlobe() {
    try {
        const el = document.getElementById('vanta-bg');
        el?.classList.remove('active');
        __vanta?.destroy?.();
        __vanta = null;
        try { localStorage.setItem('xui_bg', 'off'); } catch(e) {}
    } catch(e) {}
}

function toggleVantaGlobe() {
    const on = !!__vanta;
    if (on) stopVantaGlobe();
    else startVantaGlobe();
}

// Theme toggle (night mode / day mode)
try {
    const btnTheme = document.getElementById('btn-theme');
    const applyTheme = (mode) => {
        const light = mode === 'light';
        document.body.classList.toggle('theme-light', light);
        try { localStorage.setItem('xui_theme', light ? 'light' : 'dark'); } catch(e) {}
        try {
            const icon = btnTheme?.querySelector('i');
            if (icon) icon.className = light ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
        } catch(e) {}
    };

    // load saved theme
    try { applyTheme(localStorage.getItem('xui_theme') || 'dark'); } catch(e) {}

    btnTheme?.addEventListener('click', () => {
        const isLight = document.body.classList.contains('theme-light');
        applyTheme(isLight ? 'dark' : 'light');
        try { if (typeof gsap !== 'undefined') gsap.fromTo(btnTheme, { scale: 0.98 }, { scale: 1, duration: 0.12 }); } catch(e) {}
    });
} catch(e) {}

// Background toggle
try {
    const btnBg = document.getElementById('btn-bg');
    // restore
    try {
        const state = localStorage.getItem('xui_bg') || 'off';
        if (state === 'on') startVantaGlobe();
    } catch(e) {}

    btnBg?.addEventListener('click', () => {
        toggleVantaGlobe();
        try { if (typeof gsap !== 'undefined') gsap.fromTo(btnBg, { scale: 0.98 }, { scale: 1, duration: 0.12 }); } catch(e) {}
    });

    // pause on tab hidden
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            // stop to save battery
            stopVantaGlobe();
        } else {
            try {
                if ((localStorage.getItem('xui_bg') || 'off') === 'on') startVantaGlobe();
            } catch(e) {}
        }
    });
} catch(e) {}

// Modal: draggable bottom-sheet style (drag down to close). Uses GSAP Draggable if available; fallback to basic pointer drag.
try {
    const overlay = document.getElementById('modal-overlay');
    const card = overlay?.querySelector('.modal-card');

    const closeIfDragged = (dy) => {
        if (dy > 140) {
            closeModal();
            try { card.style.transform = ''; } catch(e) {}
            return true;
        }
        return false;
    };

    if (card && typeof gsap !== 'undefined' && typeof Draggable !== 'undefined') {
        gsap.registerPlugin(Draggable);
        Draggable.create(card, {
            type: 'x,y',
            inertia: false, // InertiaPlugin is paid.
            bounds: window,
            cursor: 'grab',
            activeCursor: 'grabbing',
            onDragEnd: function() {
                const dy = this.y || 0;
                if (!closeIfDragged(dy)) {
                    gsap.to(card, { x: 0, y: 0, duration: 0.18, ease: 'power2.out' });
                }
            }
        });
    } else if (card) {
        // fallback
        let dragging = false;
        let startX = 0, startY = 0;
        let baseX = 0, baseY = 0;

        const onDown = (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            dragging = true;
            const pt = e.touches?.[0] || e;
            startX = pt.clientX;
            startY = pt.clientY;
            const tr = card.style.transform || '';
            const m = tr.match(/translate\(([-0-9.]+)px,\s*([-0-9.]+)px\)/);
            baseX = m ? Number(m[1]) : 0;
            baseY = m ? Number(m[2]) : 0;
            card.style.cursor = 'grabbing';
            e.preventDefault?.();
        };

        const onMove = (e) => {
            if (!dragging) return;
            const pt = e.touches?.[0] || e;
            const dx = pt.clientX - startX;
            const dy = pt.clientY - startY;
            card.style.transform = `translate(${baseX + dx}px, ${baseY + dy}px)`;
        };

        const onUp = () => {
            if (!dragging) return;
            dragging = false;
            card.style.cursor = '';
            const tr = card.style.transform || '';
            const m = tr.match(/translate\(([-0-9.]+)px,\s*([-0-9.]+)px\)/);
            const dy = m ? Number(m[2]) : 0;
            if (!closeIfDragged(dy)) {
                card.style.transform = '';
            }
        };

        card.addEventListener('pointerdown', onDown);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    }
} catch(e) {}

// Admin API Tool
try {
    document.getElementById('btn-api-send').addEventListener('click', async () => {
        const path = document.getElementById('api-path').value.trim().replace(/^\/+/, '');
        const method = document.getElementById('api-method').value;
        const bodyText = document.getElementById('api-body').value.trim();
        const respBox = document.getElementById('api-response');
        respBox.value = 'Loading...';

        const url = `/api/xui/${path}`;
        const opts = { method, headers: getAdminHeaders() };

        if (method === 'POST') {
            opts.headers['Content-Type'] = 'application/json';
            if (bodyText) {
                try { JSON.parse(bodyText); } catch(e) {
                    respBox.value = 'Invalid JSON body';
                    return;
                }
                opts.body = bodyText;
            } else {
                opts.body = '{}';
            }
        }

        try {
            const res = await fetch(url, opts);
            const txt = await res.text();
            // pretty print JSON if possible
            try {
                const j = JSON.parse(txt);
                respBox.value = JSON.stringify(j, null, 2);
            } catch(e) {
                respBox.value = txt;
            }
        } catch (e) {
            respBox.value = String(e);
        }
    });
} catch(e) {}

let __adminEventSource = null;
let __adminSseRetry = null;

function startAdminSSE() {
    try { __adminEventSource?.close?.(); } catch(e) {}
    __adminEventSource = null;

    // EventSource can't send custom headers. If you're using Bearer auth, SSE won't work.
    // Best: protect admin via Cloudflare Access (identity headers/cookie), then SSE is authorized.
    const es = new EventSource('/api/stream');
    __adminEventSource = es;

    es.addEventListener('hello', () => {
        // optional: console.log('SSE connected');
    });

    es.addEventListener('metrics', (ev) => {
        try {
            const payload = JSON.parse(ev.data || '{}');
            if (payload && payload.status) {
                applyAdminStatusToUI(payload.status);
            }
        } catch(e) {}
    });

    es.addEventListener('error', () => {
        // Auto retry with backoff
        try { es.close(); } catch(e) {}
        __adminEventSource = null;
        if (__adminSseRetry) return;
        let delay = 1500;
        __adminSseRetry = setInterval(() => {
            try { clearInterval(__adminSseRetry); } catch(e) {}
            __adminSseRetry = null;
            startAdminSSE();
        }, delay);
    });
}

function stopAdminSSE() {
    try { __adminEventSource?.close?.(); } catch(e) {}
    __adminEventSource = null;
    try { clearInterval(__adminSseRetry); } catch(e) {}
    __adminSseRetry = null;
}

function switchTab(tabId) {
    try {
        document.querySelectorAll('.nav-btn, .m-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
    } catch(e) {}

    const allTabs = Array.from(document.querySelectorAll('.tab-content'));
    const targetId = `tab-${tabId}`;
    const target = document.getElementById(targetId);
    if (!target) return;

    const currentlyActive = allTabs.find(t => t.classList.contains('active'));
    if (currentlyActive === target) return;

    // Prefer GSAP (free core), fallback to anime.js
    if (typeof gsap !== 'undefined' && currentlyActive) {
        gsap.to(currentlyActive, {
            opacity: 0,
            y: 8,
            duration: 0.18,
            ease: 'power2.inOut',
            onComplete: () => {
                currentlyActive.classList.remove('active');
                currentlyActive.style.opacity = '';
                currentlyActive.style.transform = '';

                target.classList.add('active');
                gsap.fromTo(target, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.26, ease: 'power2.out' });
            }
        });
        return;
    }

    if (typeof anime !== 'undefined' && currentlyActive) {
        anime({
            targets: currentlyActive,
            opacity: [1, 0],
            translateY: [0, 8],
            duration: 180,
            easing: 'easeInOutCubic',
            complete: () => {
                currentlyActive.classList.remove('active');
                currentlyActive.style.opacity = '';
                currentlyActive.style.transform = '';

                target.classList.add('active');
                anime({
                    targets: target,
                    opacity: [0, 1],
                    translateY: [14, 0],
                    duration: 260,
                    easing: 'easeOutCubic'
                });
            }
        });
        return;
    }

    // no animation fallback
    allTabs.forEach(t => t.classList.toggle('active', t.id === targetId));
}

// Old nav wiring (top tabs may be removed)
try {
    document.querySelectorAll('.nav-btn, .m-nav-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
} catch(e) {}

// Admin select (replacement for top tabs)
try {
    const sel = document.getElementById('admin-tab-select');
    sel?.addEventListener('change', () => switchTab(sel.value));
} catch(e) {}


// --- Admins Charts Setup ---
let trafficChart, donutChart, cpuChart, ramChart;
function initAdminCharts() {
    try {
        if (typeof Chart === 'undefined') {
            console.warn('Chart.js not loaded; skipping charts');
            return;
        }
    } catch(e) { return; }

    const trafficCtx = document.getElementById('trafficChart')?.getContext?.('2d');
    if (!trafficCtx) return;
    trafficChart = new Chart(trafficCtx, {
        type: 'line', data: { labels: ['M','T','W','T','F','S','S'], datasets: [
            { label: 'Down', data: [5,8,4,7,9,12,10], borderColor: '#0066ff', tension: 0.4, fill: true, backgroundColor: 'rgba(0,102,255,0.05)' },
            { label: 'Up', data: [2,3,2,4,3,5,4], borderColor: '#00ffcc', tension: 0.4, fill: true, backgroundColor: 'rgba(0,255,204,0.05)' }
        ]}, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { x: { display: false }, y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#555' } } } }
    });

    const donutCtx = document.getElementById('usageDonut')?.getContext?.('2d');
    if (donutCtx) donutChart = new Chart(donutCtx, { type: 'doughnut', data: { datasets: [{ data: [70, 30], backgroundColor: ['#0066ff', '#00ffcc'], borderWidth: 0 }] }, options: { cutout: '80%', plugins: { tooltip: { enabled: false } } }});

    const cpuCtx = document.getElementById('cpuChart')?.getContext?.('2d');
    if (cpuCtx) cpuChart = new Chart(cpuCtx, { type: 'line', data: { labels: Array(10).fill(''), datasets: [{ data: [10,15,12,20,18,25,22,30,28,35], borderColor: '#00ffcc', borderWidth: 2, pointRadius: 0, tension: 0.4 }]}, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }});

    const ramCtx = document.getElementById('ramChart')?.getContext?.('2d');
    if (ramCtx) ramChart = new Chart(ramCtx, { type: 'line', data: { labels: Array(10).fill(''), datasets: [{ data: [40,42,41,45,44,48,46,50,49,52], borderColor: '#0066ff', borderWidth: 2, pointRadius: 0, tension: 0.4 }]}, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }});
}

// --- Admin Data Injection ---
function applyAdminStatusToUI(stat) {
    if (!stat || !stat.success) return;
    const s = stat.obj;

    // Prefer all-time traffic counters if available; netIO is often instantaneous IO and can be tiny.
    const down = toGB((s.netTraffic && (s.netTraffic.down ?? s.netTraffic.recv)) ?? s.netIO?.down);
    const up = toGB((s.netTraffic && (s.netTraffic.up ?? s.netTraffic.sent)) ?? s.netIO?.up);
    const total = (parseFloat(down) + parseFloat(up)).toFixed(2);
    try {
        animateNumber('#total-traffic', Number(total), { decimals: 2, duration: 650 });
        animateNumber('#dl-traffic', Number(down), { decimals: 2, duration: 650 });
        animateNumber('#up-traffic', Number(up), { decimals: 2, duration: 650 });
    } catch(e) {
        setTextSafe('#total-traffic', total);
        setTextSafe('#dl-traffic', down);
        setTextSafe('#up-traffic', up);
    }

    const cpuNum = Number(s.cpu);
    const cpuPct = Number.isFinite(cpuNum) ? Math.max(0, Math.min(100, cpuNum)) : 0;
    animateNumber('#cpu-percent', cpuPct, { decimals: 1, duration: 500, formatter: (v) => `${Number(v).toFixed(1)}%` });

    const memCur = Number(s.mem?.current);
    const memTot = Number(s.mem?.total);
    const ramPct = (Number.isFinite(memCur) && Number.isFinite(memTot) && memTot > 0)
        ? Math.max(0, Math.min(100, (memCur / memTot) * 100))
        : 0;
    animateNumber('#ram-percent', ramPct, { decimals: 1, duration: 500, formatter: (v) => `${Number(v).toFixed(1)}%` });

    // IP info (from server status)
    try {
        document.getElementById('node-ip').textContent = s.publicIP?.ipv4 || s.publicIP?.ipv6 || '-';
        document.getElementById('node-region').textContent = s.publicIP?.country || '-';
        document.getElementById('node-ping').textContent = '-';
        document.getElementById('xray-version').textContent = s.xray?.version || '-';
    } catch(e) {}

    try {
        if (typeof donutChart !== 'undefined' && donutChart?.data?.datasets?.[0]) {
            donutChart.data.datasets[0].data = [Number(down), Number(up)];
            donutChart.update();
        }
    } catch(e) {}
}

async function loadAdminData() {
    try {
        window.__lastAdminUpdate = Date.now();
        try {
            const dot = document.querySelector('.user-status .status-dot');
            if (dot) dot.classList.add('online');
        } catch(e) {}

        const [stat, inb, cli, sys] = await Promise.all([
            fetch('/api/status', {headers: getAdminHeaders()}).then(r => r.json()),
            fetch('/api/inbounds', {headers: getAdminHeaders()}).then(r => r.json()),
            fetch('/api/clients', {headers: getAdminHeaders()}).then(r => r.json()),
            fetch('/api/system-history', {headers: getAdminHeaders()}).then(r => r.json())
        ]);

        applyAdminStatusToUI(stat);

        if (inb.success) {
            // cache for add-client builder
            window.__inboundsCache = inb.obj || [];

            // fill inbound selector
            try {
                const sel = document.getElementById('addc-inbound');
                if (sel) {
                    sel.innerHTML = '';
                    (inb.obj || []).forEach(node => {
                        const opt = document.createElement('option');
                        opt.value = node.id;
                        const name = node.remark || `inbound-${node.id}`;
                        opt.textContent = `${name} • ${node.protocol?.toUpperCase?.() || node.protocol} • :${node.port}`;
                        sel.appendChild(opt);
                    });
                }
            } catch(e) {}

            const container = document.getElementById('inbound-cards-container');
            container.innerHTML = '';
            (inb.obj || []).forEach(node => {
                container.innerHTML += `
                    <div class="card item-card reveal" style="opacity:0; transform: translateY(14px);">
                        <div class="item-header">
                            <div><strong style="font-size:1.1rem">${node.remark || ''}</strong><p class="subtitle" style="margin:0">${(node.protocol||'').toUpperCase()} • Port ${node.port}</p></div>
                            <div class="status-badge ${node.enable ? 'active' : ''}">${node.enable ? 'Online' : 'Off'}</div>
                        </div>
                        <div class="item-stats">
                            <div class="stat-box"><span class="label">DOWN</span><span class="val">${toGB(node.down)} GB</span></div>
                            <div class="stat-box"><span class="label">UP</span><span class="val">${toGB(node.up)} GB</span></div>
                            <div class="stat-box"><span class="label">USERS</span><span class="val">${node.clientStats?.length ?? 0}</span></div>
                        </div>
                    </div>`;
            });

            // Stagger reveal (Inbounds)
            try {
                const els = container.querySelectorAll('.reveal');
                if (typeof gsap !== 'undefined') {
                    gsap.to(els, { opacity: 1, y: 0, duration: 0.35, stagger: 0.03, ease: 'power2.out' });
                } else if (typeof anime !== 'undefined') {
                    anime({ targets: els, opacity: [0,1], translateY: [14,0], delay: anime.stagger(30), duration: 350, easing: 'easeOutCubic' });
                } else {
                    els.forEach(el => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
                }
            } catch(e) {}
        }

        if (cli.success) {
            __clientsCache = Array.isArray(cli.obj) ? cli.obj : [];
            renderClientsList(__clientsCache);
        }

        if (sys.success) {
            try {
                cpuChart.data.datasets[0].data = sys.obj.map(p => p.cpu);
                ramChart.data.datasets[0].data = sys.obj.map(p => p.ram);
                cpuChart.update(); ramChart.update();
            } catch(e) {}
        }

    } catch(e) {
        console.error("Data Load Error", e);
        try {
            const dot = document.querySelector('.user-status .status-dot');
            if (dot) {
                dot.classList.remove('online');
                dot.style.background = 'var(--red)';
                dot.style.boxShadow = '0 0 10px var(--red)';
                if (typeof gsap !== 'undefined') {
                    gsap.fromTo(dot, { x: -2 }, { x: 2, duration: 0.06, repeat: 5, yoyo: true, clearProps: 'x' });
                } else if (typeof anime !== 'undefined') {
                    anime({ targets: dot, translateX: [-2,2], duration: 60, direction: 'alternate', loop: 5, easing: 'linear' });
                }
            }
        } catch(e2) {}
        try { showToast('Connection error while loading data', 'error'); } catch(e3) {}
    }
}

function renderClientsList(list) {
    const container = document.getElementById('client-list');
    if (!container) return;

    const term = (__clientSearchTerm || '').toLowerCase();
    const filtered = (Array.isArray(list) ? list : []).filter(u => {
        const email = String(u.email || '').toLowerCase();
        const id = String(u.id || u.uuid || '').toLowerCase();
        return !term || email.includes(term) || id.includes(term);
    });

    container.innerHTML = '';
    filtered.forEach((user) => {
        const used = toGB((user.up || 0) + (user.down || 0));
        const limitTxt = (user.total > 0) ? `${toGB(user.total)} GB` : 'Unlim';
        const id = user.id || user.uuid || '';

        container.innerHTML += `
            <div class="card item-card reveal" data-client-email="${String(user.email||'').replace(/"/g,'&quot;')}" data-client-id="${String(id).replace(/"/g,'&quot;')}" style="margin-bottom:10px; opacity:0; transform: translateY(14px); cursor:pointer;">
                <div class="item-header" style="margin:0">
                    <div style="display:flex; align-items:center; gap:12px">
                        <i class="fa-solid fa-circle-user" style="font-size:1.5rem; color:var(--blue)"></i>
                        <div>
                            <strong>${user.email}</strong>
                            <p class="subtitle" style="margin:0">Limit: ${limitTxt}</p>
                        </div>
                    </div>
                    <div class="stat-box" style="text-align:right"><span class="label">USED</span><span class="val" style="color:var(--accent)">${used} GB</span></div>
                </div>
            </div>`;
    });

    // animate list in
    try {
        const els = container.querySelectorAll('.reveal');
        if (typeof gsap !== 'undefined') {
            gsap.to(els, { opacity: 1, y: 0, duration: 0.35, stagger: 0.02, ease: 'power2.out' });
        } else if (typeof anime !== 'undefined') {
            anime({ targets: els, opacity: [0,1], translateY: [14,0], delay: anime.stagger(20), duration: 320, easing: 'easeOutCubic' });
        } else {
            els.forEach(el => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
        }
    } catch(e) {}
}

function openClientDrawer(user) {
    const wrap = document.getElementById('client-drawer');
    const backdrop = document.getElementById('drawer-backdrop');
    const panel = wrap?.querySelector('.drawer-panel');
    if (!wrap || !backdrop || !panel) return;

    document.getElementById('drawer-title').textContent = user.email || 'Client';
    document.getElementById('drawer-sub').textContent = user.id || user.uuid || '';

    const used = toGB((user.up || 0) + (user.down || 0));
    const down = toGB(user.down || 0);
    const up = toGB(user.up || 0);
    const limit = user.total > 0 ? `${toGB(user.total)} GB` : 'Unlimited';

    const body = document.getElementById('drawer-body');
    if (body) {
        body.innerHTML = `
            <div class="card" style="padding:14px;">
                <h3 style="margin-bottom:10px;"><i class="fa-solid fa-chart-simple"></i> Usage</h3>
                <div class="info-row"><span>Used:</span> <strong id="drawer-used">${used} GB</strong></div>
                <div class="info-row"><span>Download:</span> <strong>${down} GB</strong></div>
                <div class="info-row"><span>Upload:</span> <strong>${up} GB</strong></div>
                <div class="info-row"><span>Limit:</span> <strong>${limit}</strong></div>
            </div>
            <div class="card" style="padding:14px;">
                <h3 style="margin-bottom:10px;"><i class="fa-solid fa-screwdriver-wrench"></i> Quick Actions</h3>
                <p class="subtitle">Uses the same tools as “Client Tools” tab.</p>
            </div>
        `;
    }

    // wire actions
    try {
        const setToolEmail = () => {
            const tool = document.getElementById('tool-email');
            if (tool) tool.value = user.email || '';
        };
        document.getElementById('drawer-reset').onclick = () => { setToolEmail(); document.getElementById('btn-client-reset')?.click(); };
        document.getElementById('drawer-delete').onclick = () => { setToolEmail(); document.getElementById('btn-client-del')?.click(); };
    } catch(e) {}

    wrap.style.display = 'block';
    wrap.setAttribute('aria-hidden', 'false');

    try {
        if (typeof gsap !== 'undefined') {
            gsap.to(backdrop, { opacity: 1, duration: 0.2 });
            gsap.to(panel, { x: 0, duration: 0.28, ease: 'power2.out' });
        } else if (typeof anime !== 'undefined') {
            anime({ targets: backdrop, opacity: [0,1], duration: 200, easing: 'linear' });
            anime({ targets: panel, translateX: ['110%','0%'], duration: 280, easing: 'easeOutCubic' });
        } else {
            backdrop.style.opacity = '1';
            panel.style.transform = 'translateX(0)';
        }
    } catch(e) {}
}

function closeClientDrawer() {
    const wrap = document.getElementById('client-drawer');
    const backdrop = document.getElementById('drawer-backdrop');
    const panel = wrap?.querySelector('.drawer-panel');
    if (!wrap || !backdrop || !panel) return;

    const done = () => {
        wrap.style.display = 'none';
        wrap.setAttribute('aria-hidden', 'true');
        backdrop.style.opacity = '0';
        panel.style.transform = '';
    };

    try {
        if (typeof gsap !== 'undefined') {
            gsap.to(backdrop, { opacity: 0, duration: 0.18 });
            gsap.to(panel, { x: '110%', duration: 0.22, ease: 'power2.in', onComplete: done });
            return;
        }
        if (typeof anime !== 'undefined') {
            anime({ targets: backdrop, opacity: [1,0], duration: 180, easing: 'linear' });
            anime({ targets: panel, translateX: ['0%','110%'], duration: 220, easing: 'easeInCubic', complete: done });
            return;
        }
    } catch(e) {}

    done();
}

// Clients: search + click-to-drawer
try {
    const inp = document.getElementById('client-search');
    inp?.addEventListener('input', () => {
        __clientSearchTerm = inp.value || '';
        renderClientsList(__clientsCache);
    });

    document.getElementById('client-list')?.addEventListener('click', (e) => {
        const card = e.target?.closest?.('[data-client-email]');
        if (!card) return;
        const email = card.getAttribute('data-client-email');
        const user = (__clientsCache || []).find(u => String(u.email) === String(email));
        if (user) openClientDrawer(user);
    });

    document.getElementById('drawer-close')?.addEventListener('click', closeClientDrawer);
    document.getElementById('drawer-backdrop')?.addEventListener('click', closeClientDrawer);
} catch(e) {}

// Settings Saving
// Cloudflare Pages backend is env-var based; settings POST is read-only.
// UX: make it clear and disable to avoid confusing users.
document.getElementById("btn-save-settings").addEventListener("click", async () => {
    const btn = document.getElementById("btn-save-settings");
    showToast("This dashboard is configured via Cloudflare Pages environment variables (PANEL_URL / PANEL_USERNAME / PANEL_PASSWORD).", "error");
    btn.textContent = "Managed by Cloudflare";
    btn.disabled = true;
    btn.style.opacity = '0.7';
    btn.style.cursor = 'not-allowed';
});

// --- Server Tools (Admin-only; uses /api/xui proxy) ---
function setServerOutput(val) {
    try {
        const el = document.getElementById('server-output');
        if (el) el.value = typeof val === 'string' ? val : JSON.stringify(val, null, 2);
    } catch(e) {}
}

async function callXui(path, method='GET', bodyObj=null) {
    const url = `/api/xui/${path.replace(/^\/+/, '')}`;
    const opts = { method, headers: getAdminHeaders() };
    if (method === 'POST') {
        opts.headers = { ...opts.headers, 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(bodyObj ?? {});
    }
    const res = await fetch(url, opts);
    const ct = res.headers.get('Content-Type') || '';
    if (ct.includes('application/json')) return await res.json();
    return await res.text();
}

async function downloadFromXui(path, filename) {
    const url = `/api/xui/${path.replace(/^\/+/, '')}`;
    const res = await fetch(url, { method: 'GET', headers: getAdminHeaders() });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function wireServerTools() {
    const byId = (id) => document.getElementById(id);

    byId('btn-xray-restart')?.addEventListener('click', async () => {
        setServerOutput('Restarting Xray...');
        const r = await callXui('server/restartXrayService', 'POST', {});
        setServerOutput(r);
        loadAdminData();
    });

    byId('btn-xray-stop')?.addEventListener('click', async () => {
        setServerOutput('Stopping Xray...');
        const r = await callXui('server/stopXrayService', 'POST', {});
        setServerOutput(r);
        loadAdminData();
    });

    byId('btn-geo-update')?.addEventListener('click', async () => {
        setServerOutput('Updating geo files...');
        const r = await callXui('server/updateGeofile', 'POST', {});
        setServerOutput(r);
    });

    byId('btn-dl-config')?.addEventListener('click', async () => {
        setServerOutput('Downloading config.json...');
        await downloadFromXui('server/getConfigJson', 'config.json');
        setServerOutput('Downloaded config.json');
    });

    byId('btn-dl-db')?.addEventListener('click', async () => {
        setServerOutput('Downloading database...');
        await downloadFromXui('server/getDb', 'x-ui.db');
        setServerOutput('Downloaded x-ui.db');
    });

    byId('btn-new-uuid')?.addEventListener('click', async () => {
        try {
            const r = await callXui('server/getNewUUID', 'GET');
            const u = extractUuid(r) || uuidFallback();
            setServerOutput({ raw: r, uuid: u });
        } catch(e) {
            setServerOutput({ error: String(e), uuid: uuidFallback() });
        }
    });

    byId('btn-new-x25519')?.addEventListener('click', async () => {
        const r = await callXui('server/getNewX25519Cert', 'GET');
        setServerOutput(r);
    });

    const getCount = () => Number(byId('log-count')?.value || 200);

    byId('btn-logs')?.addEventListener('click', async () => {
        const c = getCount();
        const r = await callXui(`server/logs/${c}`, 'POST', { level: 'info', syslog: false });
        setServerOutput(r);
    });

    byId('btn-xray-logs')?.addEventListener('click', async () => {
        const c = getCount();
        const r = await callXui(`server/xraylogs/${c}`, 'POST', { filter: '', level: 'info' });
        setServerOutput(r);
    });
}

// wire once
try { wireServerTools(); } catch(e) {}

// --- Inbounds: Add Client (VLESS) ---
function buildLinksForClient(inbound, client) {
    try {
        const host = window.location.hostname.replace(/^www\./, '');
        const panelHost = host; // same domain assumption

        const subLink = client.subId ? `https://${panelHost}:7262/sub/nope/${client.subId}` : null;

        const stream = JSON.parse(inbound.streamSettings || '{}');
        const port = inbound.port;
        const remark = inbound.remark || port;
        const network = stream.network || 'ws';
        const security = stream.security || 'none';

        let qs = new URLSearchParams();
        qs.set('type', network);
        qs.set('encryption', 'none');

        if (network === 'ws') {
            const ws = stream.wsSettings || {};
            qs.set('path', ws.path || '/');
            const wsHost = ws.host || panelHost;
            qs.set('host', wsHost);
        }

        if (security === 'tls') {
            qs.set('security', 'tls');
            const tls = stream.tlsSettings || {};
            const sni = tls.serverName || panelHost;
            qs.set('sni', sni);
            const alpn = Array.isArray(tls.alpn) ? tls.alpn.join(',') : '';
            if (alpn) qs.set('alpn', alpn);
            const fp = tls.settings?.fingerprint || 'chrome';
            if (fp) qs.set('fp', fp);
        }

        const vlessLink = `vless://${client.id}@${panelHost}:${port}?${qs.toString()}#${encodeURIComponent(`${remark}-${client.email}`)}`;
        return { vlessLink, subLink };
    } catch(e) {
        return { vlessLink: null, subLink: null };
    }
}

function extractUuid(val) {
    // Accept common 3x-ui responses + plain text.
    try {
        if (!val) return null;
        if (typeof val === 'string') return val.trim();
        // 3x-ui often returns: { success:true, obj:"uuid" }
        const cand = val.obj || val.uuid || val.data || val.result;
        if (typeof cand === 'string') return cand.trim();
        if (cand && typeof cand === 'object') {
            const nested = cand.uuid || cand.id;
            if (typeof nested === 'string') return nested.trim();
        }
        return null;
    } catch(e) {
        return null;
    }
}

function uuidFallback() {
    // Browser-side fallback if x-ui UUID endpoint fails.
    try {
        if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
            return globalThis.crypto.randomUUID();
        }
    } catch(e) {}
    // RFC4122 v4 fallback
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

async function addClientVless() {
    const out = document.getElementById('addc-result');
    const uiCard = document.getElementById('ui-result');
    const uiBody = document.getElementById('ui-result-body');
    const inboundId = Number(document.getElementById('addc-inbound')?.value);
    const email = document.getElementById('addc-email')?.value?.trim();
    const limitGb = Number(document.getElementById('addc-limit')?.value || 0);
    const days = Number(document.getElementById('addc-days')?.value || 0);

    const showUICard = () => { if (uiCard) uiCard.style.display = 'block'; if (uiBody) uiBody.innerHTML = ''; };
    const addKV = (k,v) => { const row=document.createElement('div'); row.className='kv'; row.innerHTML=`<div class="k">${k}</div><div class="v">${v}</div>`; uiBody.appendChild(row); };
    const addCopyField = (label, value) => {
        const wrap=document.createElement('div');
        wrap.innerHTML = `<div style="font-size:0.8rem;color:var(--text-dim);margin-bottom:6px;">${label}</div>`;
        const row=document.createElement('div'); row.className='copy-row';
        const inp=document.createElement('input'); inp.value=value||''; inp.readOnly=true;
        const btn=document.createElement('button'); btn.className='sys-btn'; btn.textContent='Copy';
        btn.addEventListener('click', async ()=>{ try{ await navigator.clipboard.writeText(value||''); showToast('Copied'); }catch(e){ showToast('Copy failed','error'); } });
        row.appendChild(inp); row.appendChild(btn);
        wrap.appendChild(row);
        uiBody.appendChild(wrap);
    };

    if (!email) { showToast('Enter client email/ID', 'error'); return; }
    if (!inboundId) { showToast('Select inbound', 'error'); return; }

    showUICard();
    addKV('Action','Create Client');
    addKV('Status','Working...');
    out.value = 'Creating client...';

    // get uuid (prefer x-ui endpoint; fallback to browser UUID)
    let clientId = null;
    try {
        const uuidRes = await callXui('server/getNewUUID', 'GET');
        clientId = extractUuid(uuidRes);
    } catch(e) {
        clientId = null;
    }
    if (!clientId) {
        // Don’t hard-fail: generate locally so the tool still works even if x-ui endpoint is flaky.
        clientId = uuidFallback();
        showToast('UUID endpoint failed — used local UUID', 'info');
    }

    const subId = Math.random().toString(36).slice(2, 18);
    const expiryTime = days > 0 ? (Date.now() + days * 24 * 60 * 60 * 1000) : 0;
    const totalGB = limitGb > 0 ? Math.floor(limitGb * (1024 ** 3)) : 0;

    const payload = {
        id: inboundId,
        settings: {
            clients: [
                {
                    id: clientId,
                    email,
                    enable: true,
                    expiryTime,
                    limitIp: 0,
                    reset: 0,
                    subId,
                    totalGB,
                    flow: '',
                    tgId: ''
                }
            ]
        }
    };

    const res = await callXui('inbounds/addClient', 'POST', payload);

    // Build links from cached inbound
    const inb = (window.__inboundsCache || []).find(x => Number(x.id) === inboundId);
    const links = inb ? buildLinksForClient(inb, { id: clientId, email, subId }) : { vlessLink: null, subLink: null };

    const payloadOut = { api: res };
    out.value = JSON.stringify(payloadOut, null, 2);

    try {
        const uiBody = document.getElementById('ui-result-body');
        if (uiBody) {
            uiBody.innerHTML = '';
            const ok = res && (res.success === true || res.msg === 'success');
            const status = ok ? 'Success' : 'Check response';
            const row = document.createElement('div');
            row.className = 'kv';
            row.innerHTML = `<div class="k">Status</div><div class="v" style="color:${ok?'var(--green)':'var(--accent)'}">${status}</div>`;
            uiBody.appendChild(row);

            const addCopy = (label,val) => {
                const wrap=document.createElement('div');
                wrap.innerHTML = `<div style="font-size:0.8rem;color:var(--text-dim);margin-bottom:6px;">${label}</div>`;
                const row=document.createElement('div'); row.className='copy-row';
                const inp=document.createElement('input'); inp.value=val||''; inp.readOnly=true;
                const btn=document.createElement('button'); btn.className='sys-btn'; btn.textContent='Copy';
                btn.addEventListener('click', async ()=>{ try{ await navigator.clipboard.writeText(val||''); showToast('Copied'); }catch(e){ showToast('Copy failed','error'); } });
                row.appendChild(inp); row.appendChild(btn);
                wrap.appendChild(row);
                uiBody.appendChild(wrap);
            };

            // Intentionally not showing subscription/VLESS links in the dashboard UI
            
        }
        const uiCard = document.getElementById('ui-result');
        if (uiCard) uiCard.style.display = 'block';
    } catch(e) {}

    showToast('Client created');

    // refresh view
    loadAdminData();
}

try {
    const out = () => document.getElementById('addc-result');
    const getInboundId = () => Number(document.getElementById('addc-inbound')?.value);
    const getEmail = () => (document.getElementById('tool-email')?.value || '').trim();

    // Draggable sliders for limit/days (GSAP Draggable -> anime.js fallback)
    const wireDragSlider = ({ trackId, handleId, fillId, inputId, valId, max, step=1 }) => {
        const track = document.getElementById(trackId);
        const handle = document.getElementById(handleId);
        const fill = document.getElementById(fillId);
        const input = document.getElementById(inputId);
        const outVal = document.getElementById(valId);
        if (!track || !handle || !fill || !input || !outVal) return;

        const setFromValue = (v) => {
            const clamped = Math.max(0, Math.min(max, Math.round(Number(v)/step)*step));
            input.value = String(clamped);
            outVal.textContent = String(clamped);
            const pct = (clamped / max) * 100;
            fill.style.width = `${pct}%`;
            handle.style.left = `${pct}%`;
        };

        // sync when user types
        input.addEventListener('input', () => setFromValue(input.value));

        // init
        setFromValue(input.value || 0);

        const pxToVal = (x) => {
            const r = track.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (x - r.left) / r.width));
            return pct * max;
        };

        // click on track
        track.addEventListener('pointerdown', (e) => {
            setFromValue(pxToVal(e.clientX));
        });

        if (typeof gsap !== 'undefined' && typeof Draggable !== 'undefined') {
            gsap.registerPlugin(Draggable);
            Draggable.create(handle, {
                type: 'x',
                bounds: track,
                onDrag: function() {
                    const r = track.getBoundingClientRect();
                    const cx = r.left + (this.x + (handle.offsetWidth/2));
                    setFromValue(pxToVal(cx));
                },
                onPress: function() { handle.style.cursor = 'grabbing'; },
                onRelease: function() { handle.style.cursor = 'grab'; }
            });
        } else {
            // basic drag fallback
            let dragging=false;
            const onDown = (e) => { dragging=true; handle.setPointerCapture?.(e.pointerId); handle.style.cursor='grabbing'; };
            const onMove = (e) => { if(!dragging) return; setFromValue(pxToVal(e.clientX)); };
            const onUp = () => { dragging=false; handle.style.cursor='grab'; };
            handle.addEventListener('pointerdown', onDown);
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        }
    };

    wireDragSlider({ trackId:'limit-track', handleId:'limit-handle', fillId:'limit-fill', inputId:'addc-limit', valId:'limit-val', max: 500, step: 1 });
    wireDragSlider({ trackId:'days-track', handleId:'days-handle', fillId:'days-fill', inputId:'addc-days', valId:'days-val', max: 365, step: 1 });

    document.getElementById('btn-add-client')?.addEventListener('click', addClientVless);
    document.getElementById('btn-add-client-refresh')?.addEventListener('click', loadAdminData);

    const showResultUI = (title, obj) => {
        const uiCard = document.getElementById('ui-result');
        const uiBody = document.getElementById('ui-result-body');
        const raw = document.getElementById('addc-result');
        if (uiCard) uiCard.style.display = 'block';
        if (uiBody) uiBody.innerHTML = '';
        if (raw) raw.value = JSON.stringify(obj, null, 2);

        const addTitle = (t) => {
            const h=document.createElement('div');
            h.style.fontWeight='800';
            h.textContent=t;
            uiBody.appendChild(h);
        };
        const addChips = (arr) => {
            const w=document.createElement('div'); w.className='chips';
            (arr||[]).forEach(x=>{ const c=document.createElement('div'); c.className='chip'; c.textContent=String(x); w.appendChild(c); });
            uiBody.appendChild(w);
        };
        const addKV = (k,v) => { const row=document.createElement('div'); row.className='kv'; row.innerHTML=`<div class="k">${k}</div><div class="v">${v}</div>`; uiBody.appendChild(row); };

        addTitle(title);

        if (obj && obj.success === false) {
            addKV('Status','Failed');
            addKV('Message', obj.msg || obj.error || '-');
            return;
        }

        // Onlines: obj.obj is list
        if (obj && Array.isArray(obj.obj)) {
            addKV('Count', obj.obj.length);
            addChips(obj.obj);
            return;
        }

        // Last online: obj.obj is list of {email,lastOnline}
        if (obj && Array.isArray(obj.obj?.data)) {
            addKV('Count', obj.obj.data.length);
            addChips(obj.obj.data.map(x => `${x.email}: ${x.lastOnline}`));
            return;
        }

        // Default
        addKV('Status','OK');
        addKV('Info','See raw JSON below');
    };

    // Inbound tools
    document.getElementById('btn-inb-onlines')?.addEventListener('click', async () => {
        const r = await callXui('inbounds/onlines', 'POST', {});
        showResultUI('Online users', r);
    });

    document.getElementById('btn-inb-lastonline')?.addEventListener('click', async () => {
        const r = await callXui('inbounds/lastOnline', 'POST', {});
        showResultUI('Last online', r);
    });

    document.getElementById('btn-inb-reset')?.addEventListener('click', async () => {
        const id = getInboundId();
        if (!id) return;
        if (!confirm(`Reset ALL client traffic for inbound ${id}?`)) return;
        const r = await callXui(`inbounds/resetAllClientTraffics/${id}`, 'POST', {});
        showResultUI(`Reset inbound ${id}`, r);
        loadAdminData();
    });

    document.getElementById('btn-all-reset')?.addEventListener('click', async () => {
        if (!confirm('Reset ALL traffics for ALL inbounds?')) return;
        const r = await callXui('inbounds/resetAllTraffics', 'POST', {});
        showResultUI('Reset ALL traffics', r);
        loadAdminData();
    });

    // Client tools
    document.getElementById('btn-client-reset')?.addEventListener('click', async () => {
        const inboundId = getInboundId();
        const email = getEmail();
        if (!inboundId || !email) { showToast('Select inbound + enter email', 'error'); return; }
        if (!confirm(`Reset traffic for ${email} in inbound ${inboundId}?`)) return;
        const r = await callXui(`inbounds/${inboundId}/resetClientTraffic/${encodeURIComponent(email)}`, 'POST', {});
        showResultUI(`Reset traffic: ${email}`, r);
        loadAdminData();
    });

    document.getElementById('btn-client-del')?.addEventListener('click', async () => {
        const inboundId = getInboundId();
        const email = getEmail();
        if (!inboundId || !email) { showToast('Select inbound + enter email', 'error'); return; }
        if (!confirm(`DELETE client ${email} from inbound ${inboundId}?`)) return;
        const r = await callXui(`inbounds/${inboundId}/delClientByEmail/${encodeURIComponent(email)}`, 'POST', {});
        showResultUI(`Delete client: ${email}`, r);
        loadAdminData();
    });

    document.getElementById('btn-client-ips')?.addEventListener('click', async () => {
        const email = getEmail();
        if (!email) { showToast('Enter email', 'error'); return; }
        const r = await callXui(`inbounds/clientIps/${encodeURIComponent(email)}`, 'POST', {});
        showResultUI(`Client IPs: ${email}`, r);
    });

    document.getElementById('btn-client-ips-clear')?.addEventListener('click', async () => {
        const email = getEmail();
        if (!email) { showToast('Enter email', 'error'); return; }
        if (!confirm(`Clear IPs for ${email}?`)) return;
        const r = await callXui(`inbounds/clearClientIps/${encodeURIComponent(email)}`, 'POST', {});
        showResultUI(`Clear IPs: ${email}`, r);
    });

} catch(e) {}

// Setup Initial State
document.addEventListener("DOMContentLoaded", async () => {
    // If we came back from Cloudflare Access (e.g., after visiting /api/status),
    // verify admin session and open admin UI.
    try {
        const p = new URLSearchParams(window.location.search);
        if (p.get('admin') === '1') {
            // remove query param
            window.history.replaceState({}, document.title, window.location.pathname);
            currentRole = 'admin';
            adminToken = 'zero-trust-secured';
            sessionStorage.setItem('xui_admin_token', 'zero-trust-secured');
            startAdminApp();
        }
    } catch(e) {}

    // Restore cached login inputs/tab + allow direct-link auto fill
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const lastTab = localStorage.getItem('xui_last_tab') || 'client';
        const cachedClient = localStorage.getItem('xui_client_id') || '';

        const directClient = (urlParams.get('client') || urlParams.get('id') || '').trim();
        const directAuto = urlParams.get('auto') === '1' || urlParams.get('auto') === 'true';

        if (directClient) {
            document.getElementById('login-email').value = directClient;
            // also cache it
            try { localStorage.setItem('xui_client_id', directClient); localStorage.setItem('xui_last_tab', 'client'); } catch(e) {}
        } else if (cachedClient) {
            document.getElementById('login-email').value = cachedClient;
        }

        if (directClient || directAuto) {
            document.getElementById('tab-login-client').click();
        } else if (lastTab === 'admin') {
            document.getElementById('tab-login-admin').click();
        } else {
            document.getElementById('tab-login-client').click();
        }

        // Auto restore session
        const tok = sessionStorage.getItem('xui_admin_token');
        if (tok) {
            // verify session by calling status
            const headers = (tok === 'zero-trust-secured') ? {} : { Authorization: `Bearer ${tok}` };
            fetch('/api/status', { headers })
              .then(r => r.json())
              .then(j => {
                  if (j && j.success) {
                      currentRole = 'admin';
                      adminToken = tok;
                      startAdminApp();
                  } else {
                      // Not logged in / blocked by Access
                      sessionStorage.removeItem('xui_admin_token');
                  }
              })
              .catch(() => { sessionStorage.removeItem('xui_admin_token'); });
        } else if ((lastTab === 'client' && cachedClient) || directAuto) {
            const idToCheck = (directClient || cachedClient || '').trim();
            if (idToCheck) {
                // auto run client check again (or via direct link ?client=...&auto=1)
                fetch('/public/auth', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: 'client', id: idToCheck })
                }).then(r => r.json()).then(d => {
                    if (d && d.success) {
                        currentRole = 'client';
                        startClientApp(d.clientData);
                    } else if (directAuto) {
                        showToast((d && d.msg) || 'User not found', 'error');
                    }
                }).catch(()=>{ if (directAuto) showToast('Connection Error', 'error'); });
            }
        }

    } catch(e) {}

    // Hide UI elements until login
    document.querySelector('.desktop-nav').style.display = 'none';
    document.querySelector('.mobile-nav').style.display = 'none';
    document.getElementById('main-fab').style.display = 'none';
    
    // Auto-check for Zero Trust
    try {
        const res = await fetch('/api/auth', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'admin', username: '', password: '' })
        });
        const data = await res.json();
        if(data.success && data.msg === 'Cloudflare Zero Trust Authenticated') {
            currentRole = 'admin';
            adminToken = 'zero-trust-secured'; 
            startAdminApp();
        }
    } catch(e) {}
});
