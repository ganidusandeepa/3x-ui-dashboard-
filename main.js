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
    if (!Number.isFinite(endVal)) { el.textContent = formatter(0); return; }

    try {
        if (typeof gsap !== 'undefined') {
            const obj = { v: startVal };
            gsap.to(obj, { v: endVal, duration: duration / 1000, ease: 'power2.out', onUpdate: () => { el.textContent = formatter(obj.v); } });
            return;
        }
    } catch(e) {}

    try {
        if (typeof anime !== 'undefined') {
            const obj = { v: startVal };
            anime({ targets: obj, v: endVal, duration, easing: 'easeOutCubic', update: () => { el.textContent = formatter(obj.v); } });
            return;
        }
    } catch(e) {}

    el.textContent = formatter(endVal);
}

// --- Global State ---
let currentRole = null;
let adminToken = null;
let loopInterval = null;
let clientLoopInterval = null;
let __clientLast = null;
let __clientEventSource = null;
let __clientSseRetry = null;
let __vanta = null;
let __clientsCache = [];
let __clientSearchTerm = '';
let __bulkSelected = new Set();
let __autoRefreshOntimer = null;
let __expiryCountdownTimer = null;
let __currentClientData = null; // last client data for QR / countdown

// --- Client SSE ---
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
        try { const c = JSON.parse(ev.data || '{}'); if (c && (c.email || c.down !== undefined)) applyClientDataToUI(c); } catch(e) {}
    });
    es.addEventListener('notfound', () => { stopClientSSE(); showToast('User not found', 'error'); });
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
    try { clearInterval(__autoRefreshOntimer); } catch(e) {}
    try { clearInterval(__expiryCountdownTimer); } catch(e) {}
    loopInterval = null; clientLoopInterval = null; __autoRefreshOntimer = null;
    __expiryCountdownTimer = null; __currentClientData = null;
    currentRole = null; adminToken = null;
    try { sessionStorage.removeItem('xui_admin_token'); } catch(e) {}
    document.getElementById('login-overlay').style.display = 'flex';
    try { document.querySelector('.desktop-nav')?.style && (document.querySelector('.desktop-nav').style.display = 'none'); } catch(e) {}
    try { document.querySelector('.mobile-nav')?.style && (document.querySelector('.mobile-nav').style.display = 'none'); } catch(e) {}
    document.getElementById('main-fab').style.display = 'none';
    try { document.getElementById('tab-login-client').click(); } catch(e) {}
}

document.addEventListener('click', (e) => {
    if (e.target && (e.target.id === 'btn-logout' || e.target.closest('#btn-logout'))) doLogout();
    try {
        const btn = e.target?.closest?.('button');
        if (btn && typeof gsap !== 'undefined') gsap.fromTo(btn, { scale: 0.98 }, { scale: 1, duration: 0.14, ease: 'power2.out' });
        else if (btn && typeof anime !== 'undefined') anime({ targets: btn, scale: [0.98, 1], duration: 160, easing: 'easeOutCubic' });
    } catch(e) {}
});

function showToast(msg, type="info") {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.style.borderColor = type === 'error' ? 'var(--red)' : 'var(--accent)';
    toast.innerHTML = `<i class="fa-solid fa-bell"></i> <span>${msg}</span>`;
    container.appendChild(toast);
    try { if (typeof gsap !== 'undefined') gsap.fromTo(toast, { y: 10, opacity: 0 }, { y: 0, opacity: 1, duration: 0.2, ease: 'power2.out' }); } catch(e) {}
    setTimeout(() => {
        try {
            if (typeof gsap !== 'undefined') { gsap.to(toast, { opacity: 0, y: -8, duration: 0.18, ease: 'power2.in', onComplete: () => toast.remove() }); return; }
        } catch(e) {}
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// --- Login UI ---
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

document.getElementById('btn-login-admin').addEventListener('click', async () => {
    try { localStorage.setItem('xui_last_tab', 'admin'); } catch(e) {}
    window.location.href = '/api/status';
});

document.getElementById('btn-login-client').addEventListener('click', async () => {
    const id = (document.getElementById('login-email').value || '').trim();
    const btn = document.getElementById('btn-login-client');
    btn.textContent = "Checking...";
    if (!id) { showToast('Enter your email/ID', 'error'); btn.textContent = "Check Traffic"; return; }
    try { localStorage.setItem('xui_last_tab', 'client'); localStorage.setItem('xui_client_id', id || ''); } catch(e) {}
    try {
        const res = await fetch('/public/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client', id }) });
        const ct = res.headers.get('Content-Type') || '';
        if (!ct.includes('application/json')) {
            const txt = await res.text().catch(()=> '');
            showToast(res.status === 401 ? 'Session expired. Refresh and try again.' : 'Server temporary issue. Try again.', 'error');
            btn.textContent = "Check Traffic"; return;
        }
        const data = await res.json();
        if (data && data.success) { currentRole = 'client'; startClientApp(data.clientData); }
        else showToast((data && data.msg) || 'User not found', 'error');
    } catch(e) { showToast('Network/Server error. Try again.', 'error'); }
    btn.textContent = "Check Traffic";
});

// --- Admin App Start ---
async function startAdminApp() {
    document.getElementById('login-overlay').style.display = 'none';
    try { document.getElementById('btn-logout').style.display = 'inline-flex'; } catch(e) {}
    document.getElementById('tab-user-view').style.display = 'none';
    try { document.querySelector('.desktop-nav')?.style && (document.querySelector('.desktop-nav').style.display = 'none'); } catch(e) {}
    try { document.querySelector('.mobile-nav')?.style && (document.querySelector('.mobile-nav').style.display = 'none'); } catch(e) {}
    document.getElementById('main-fab').style.display = 'flex';

    try {
        const sel = document.getElementById('admin-tab-select');
        if (sel) sel.style.display = 'inline-flex';
        if (sel && sel.value) switchTab(sel.value);
        else switchTab('overview');
    } catch(e) { switchTab('overview'); }

    initAdminCharts();
    await loadAdminData();

    try {
        const hero = document.querySelector('#tab-overview .data-card-hero');
        if (typeof gsap !== 'undefined') {
            if (hero) { gsap.fromTo(hero, { opacity: 0, y: 18, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: 'power2.out' }); }
            gsap.from('.resource-card, .card:not(.data-card-hero)', { opacity: 0, y: 12, duration: 0.35, stagger: 0.02, ease: 'power2.out', delay: 0.05 });
        } else if (typeof anime !== 'undefined') {
            if (hero) anime({ targets: hero, opacity: [0,1], translateY: [18,0], scale: [0.98,1], duration: 520, easing: 'easeOutCubic' });
            anime({ targets: document.querySelectorAll('.card, .item-card'), opacity: [0,1], translateY: [14,0], delay: anime.stagger(20), duration: 380, easing: 'easeOutCubic' });
        }
    } catch(e) {}

    loopInterval = setInterval(loadAdminData, 60000);
    try { startAdminSSE(); } catch(e) {}

    fetch('/api/settings').then(r=>r.json()).then(set=>{
        if(set && set.panelUrl) {
            document.getElementById("setting-url").value = set.panelUrl;
            document.getElementById("setting-user").value = set.username || "";
        }
    }).catch(()=>{});
}

// --- Client Speed ---
function updateClientSpeedsFromDelta(nowDown, nowUp) {
    try {
        const now = Date.now();
        if (!__clientLast) {
            __clientLast = { downBytes: Number(nowDown)||0, upBytes: Number(nowUp)||0, ts: now };
            setTextSafe('#user-dl-speed', '0'); setTextSafe('#user-up-speed', '0'); return;
        }
        const dt = (now - __clientLast.ts) / 1000;
        if (dt <= 0) return;
        const dDown = (Number(nowDown)||0) - (__clientLast.downBytes||0);
        const dUp = (Number(nowUp)||0) - (__clientLast.upBytes||0);
        animateNumber('#user-dl-speed', Math.max(0, (dDown * 8) / (dt * 1e6)), { decimals: 2, duration: 500 });
        animateNumber('#user-up-speed', Math.max(0, (dUp * 8) / (dt * 1e6)), { decimals: 2, duration: 500 });
        __clientLast = { downBytes: Number(nowDown)||0, upBytes: Number(nowUp)||0, ts: now };
    } catch(e) {}
}

// --- QR Code & Config Links ---
function generateQR(text, canvasEl, size) {
    try {
        if (typeof QRious === 'undefined' || !canvasEl || !text) return;
        new QRious({ element: canvasEl, value: text, size: size || 200, background: '#ffffff', foreground: '#000000' });
    } catch(e) {}
}

window.copyClientConfig = async function() {
    const val = document.getElementById('client-config-link')?.value || '';
    try { await navigator.clipboard.writeText(val); showToast('Config link copied'); } catch(e) { showToast('Copy failed', 'error'); }
};

window.copyClientSub = async function() {
    const val = document.getElementById('client-sub-link')?.value || '';
    try { await navigator.clipboard.writeText(val); showToast('Subscription URL copied'); } catch(e) { showToast('Copy failed', 'error'); }
};

function showClientConfig(configLink, subLink) {
    const card = document.getElementById('client-config-card');
    if (!card) return;
    if (!configLink) { card.style.display = 'none'; return; }
    card.style.display = 'block';
    const inp = document.getElementById('client-config-link');
    if (inp) inp.value = configLink;
    const canvas = document.getElementById('client-qr-canvas');
    if (canvas) generateQR(configLink, canvas, 200);
    const subRow = document.getElementById('client-sub-row');
    const subInp = document.getElementById('client-sub-link');
    if (subLink && subRow && subInp) { subRow.style.display = 'block'; subInp.value = subLink; }
    else if (subRow) subRow.style.display = 'none';
}

// --- Expiry Countdown ---
function startExpiryCountdown(expiryTime) {
    try { clearInterval(__expiryCountdownTimer); } catch(e) {}
    const el = document.getElementById('expiry-countdown');
    const val = document.getElementById('expiry-countdown-val');
    if (!el || !val) return;
    const exp = Number(expiryTime);
    if (!exp || exp <= 0) { el.style.display = 'none'; return; }
    const tick = () => {
        const diff = exp - Date.now();
        if (diff <= 0) {
            el.style.display = 'block';
            val.textContent = 'Expired';
            val.style.color = 'var(--red)';
            clearInterval(__expiryCountdownTimer);
            return;
        }
        el.style.display = 'block';
        const d = Math.floor(diff / 86400000);
        const h = Math.floor((diff % 86400000) / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        val.textContent = d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m ${s}s`;
        val.style.color = diff < 7 * 86400000 ? 'orange' : 'var(--accent)';
    };
    tick();
    __expiryCountdownTimer = setInterval(tick, 1000);
}

// --- Apply Client Data to UI ---
function applyClientDataToUI(client) {
    if (!client) return;
    __currentClientData = client;
    updateClientSpeedsFromDelta(client.down, client.up);

    const down = parseFloat(toGB(client.down));
    const up = parseFloat(toGB(client.up));
    const totalUsed = (down + up).toFixed(2);
    const limit = parseFloat(toGB(client.total));
    const remainDesc = limit === 0 ? "Unlimited GB" : `${limit.toFixed(2)} GB`;

    const fmtTime = (ms) => { const n = Number(ms); if (!Number.isFinite(n) || n <= 0) return '-'; return new Date(n).toLocaleString(); };

    try {
        if (client.email) {
            const us = document.querySelector('.user-status');
            if (us) us.innerHTML = '<span>Hi, <strong style="color:var(--accent)">' + client.email + '</strong></span>';
        }
        document.getElementById('user-email').textContent = client.email || '-';
        if (client.uuid !== undefined) document.getElementById('user-uuid').textContent = client.uuid || '-';
        if (client.subId !== undefined) document.getElementById('user-subid').textContent = client.subId || '-';
        if (client.lastOnline !== undefined) document.getElementById('user-last-online').textContent = fmtTime(client.lastOnline);
        if (client.ips !== undefined) document.getElementById('user-ips').textContent = Array.isArray(client.ips) ? (client.ips.join(', ') || 'None') : '-';
    } catch(e) {}

    animateNumber('#user-used', Number(totalUsed), { decimals: 2, duration: 500 });
    animateNumber('#user-dl', Number(down), { decimals: 2, duration: 500 });
    animateNumber('#user-up', Number(up), { decimals: 2, duration: 500 });
    setTextSafe('#user-total', remainDesc);

    try {
        const usedFmt = formatGB(Number(totalUsed));
        setTextSafe('#sub-lifetime', `${usedFmt.value} ${usedFmt.unit}`);
        const exp = Number(client.expiryTime ?? client.expiry ?? 0);
        setTextSafe('#sub-expiry', (!Number.isFinite(exp) || exp <= 0) ? 'Never' : new Date(exp).toLocaleString());
        const active = client.enable !== false;
        setTextSafe('#sub-account', active ? 'Active' : 'Disabled/Expired');
        const dot = document.getElementById('sub-status-dot');
        const st = document.getElementById('sub-status-text');
        if (dot && st) {
            st.textContent = active ? 'ACTIVE' : 'INACTIVE';
            dot.style.background = active ? 'var(--green)' : 'var(--red)';
            dot.style.boxShadow = active ? '0 0 0 4px rgba(0,255,102,0.15)' : '0 0 0 4px rgba(255,51,51,0.16)';
        }
        try {
            const top = document.getElementById('client-top-status');
            const topDot = document.getElementById('client-top-dot');
            const topText = document.getElementById('client-top-text');
            if (top && topDot && topText) {
                top.style.display = 'inline-flex';
                topText.textContent = active ? 'ACTIVE' : 'INACTIVE';
                topDot.style.background = active ? 'var(--green)' : 'var(--red)';
            }
        } catch(e) {}
    } catch(e) {}

    try {
        const st = document.getElementById('user-status-text');
        if (st) {
            st.innerText = client.enable === false ? "Disabled or Expired" : "Active";
            st.classList.toggle('active', client.enable !== false);
            st.style.color = client.enable === false ? "var(--red)" : "";
        }
    } catch(e) {}

    try {
        const bar = document.getElementById('user-progress');
        const pctEl = document.getElementById('user-progress-pct');
        const usedEl = document.getElementById('user-progress-used');
        const remEl = document.getElementById('user-progress-remaining');
        if (usedEl) { const f = formatGB(Number(totalUsed)); usedEl.textContent = `${f.value} ${f.unit}`; }
        if (bar) {
            bar.classList.remove('anim', 'level-warn', 'level-bad');
            void bar.offsetWidth;
            bar.classList.add('anim');
            if (limit > 0) {
                let pct = Math.min(100, (Number(totalUsed) / limit) * 100);
                if (pct >= 90) bar.classList.add('level-bad');
                else if (pct >= 70) bar.classList.add('level-warn');
                if (typeof gsap !== 'undefined') gsap.to(bar, { width: `${pct}%`, duration: 0.55, ease: 'power2.out' });
                else if (typeof anime !== 'undefined') anime({ targets: bar, width: `${pct}%`, duration: 550, easing: 'easeOutCubic' });
                else bar.style.width = `${pct}%`;
                if (pctEl) { pctEl.style.display = 'inline-flex'; pctEl.textContent = `${pct.toFixed(1)}%`; }
                if (remEl) { const r = formatGB(Math.max(0, Number(limit) - Number(totalUsed))); remEl.textContent = `${r.value} ${r.unit}`; }
            } else {
                bar.style.width = '100%';
                if (pctEl) pctEl.style.display = 'none';
                if (remEl) remEl.textContent = 'Unlimited';
            }
        }
    } catch(e) {}

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

    // Expiry countdown
    try { startExpiryCountdown(client.expiryTime ?? client.expiry ?? 0); } catch(e) {}

    // Config link + QR (only update if we have a link and not already showing a non-stale link)
    try {
        const configLink = client.configLink || client.vlessLink || client.vmessLink || client.trojanLink || null;
        const subLink = client.subLink || null;
        showClientConfig(configLink, subLink);
    } catch(e) {}
}

function startClientApp(client) {
    document.getElementById('login-overlay').style.display = 'none';
    try { document.getElementById('btn-logout').style.display = 'inline-flex'; } catch(e) {}
    try { const sel = document.getElementById('admin-tab-select'); if (sel) sel.style.display = 'none'; } catch(e) {}
    try { document.querySelector('.desktop-nav')?.style && (document.querySelector('.desktop-nav').style.display = 'none'); } catch(e) {}
    try { document.querySelector('.mobile-nav')?.style && (document.querySelector('.mobile-nav').style.display = 'none'); } catch(e) {}
    document.getElementById('main-fab').style.display = 'none';
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.getElementById('tab-user-view').classList.add('active');

    applyClientDataToUI(client);

    try {
        const idToCheck = (localStorage.getItem('xui_client_id') || client.email || '').trim();
        startClientSSE(idToCheck);
    } catch(e) {}

    try { clearInterval(clientLoopInterval); } catch(e) {}
    clientLoopInterval = null;
    try {
        const idToCheck = (localStorage.getItem('xui_client_id') || client.email || '').trim();
        if (idToCheck) {
            clientLoopInterval = setInterval(() => {
                fetch('/public/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client', id: idToCheck }) })
                .then(r => r.json()).then(d => { if (d && d.success) applyClientDataToUI(d.clientData); }).catch(()=>{});
            }, 120000);
        }
    } catch(e) {}
}

// --- Admin Helpers ---
function getAdminHeaders() {
    if (!adminToken || adminToken === 'zero-trust-secured') return { 'Content-Type': 'application/json' };
    return { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
}

window.triggerAction = (action) => { showToast(`${action}...`); setTimeout(() => { showToast(`${action} Triggered`); loadAdminData(); }, 1000); };

function closeModal() { document.getElementById('modal-overlay').classList.remove('active'); }
document.getElementById('main-fab').addEventListener('click', () => {
    const m = document.getElementById('modal-overlay');
    m.classList.add('active');
    try {
        const card = m.querySelector('.modal-card');
        if (card && typeof gsap !== 'undefined') gsap.fromTo(card, { opacity: 0, y: 22, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.26, ease: 'power2.out' });
    } catch(e) {}
});

function isMobileLike() { try { return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 768; } catch(e) { return false; } }
function prefersReducedMotion() { try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch(e) { return false; } }

function startVantaGlobe() {
    try {
        const el = document.getElementById('vanta-bg');
        if (!el || prefersReducedMotion() || typeof VANTA === 'undefined' || !VANTA.GLOBE) return;
        try { __vanta?.destroy?.(); } catch(e) {}
        const mobile = isMobileLike();
        __vanta = VANTA.GLOBE({ el, mouseControls: !mobile, touchControls: true, gyroControls: false, minHeight: 200, minWidth: 200, scale: mobile ? 0.8 : 1.0, scaleMobile: 0.75, color: 0x00ffcc, color2: 0x0066ff, backgroundColor: 0x000000, size: mobile ? 0.55 : 0.75 });
        el.classList.add('active');
        try { localStorage.setItem('xui_bg', 'on'); } catch(e) {}
    } catch(e) {}
}

function stopVantaGlobe() {
    try { document.getElementById('vanta-bg')?.classList.remove('active'); __vanta?.destroy?.(); __vanta = null; localStorage.setItem('xui_bg', 'off'); } catch(e) {}
}

function toggleVantaGlobe() { if (__vanta) stopVantaGlobe(); else startVantaGlobe(); }

try {
    const btnTheme = document.getElementById('btn-theme');
    const applyTheme = (mode) => {
        const light = mode === 'light';
        document.body.classList.toggle('theme-light', light);
        try { localStorage.setItem('xui_theme', light ? 'light' : 'dark'); } catch(e) {}
        try { const icon = btnTheme?.querySelector('i'); if (icon) icon.className = light ? 'fa-solid fa-sun' : 'fa-solid fa-moon'; } catch(e) {}
    };
    try { applyTheme(localStorage.getItem('xui_theme') || 'dark'); } catch(e) {}
    btnTheme?.addEventListener('click', () => { applyTheme(document.body.classList.contains('theme-light') ? 'dark' : 'light'); });
} catch(e) {}

try {
    const btnBg = document.getElementById('btn-bg');
    try { if ((localStorage.getItem('xui_bg') || 'off') === 'on') startVantaGlobe(); } catch(e) {}
    btnBg?.addEventListener('click', () => toggleVantaGlobe());
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopVantaGlobe();
        else { try { if ((localStorage.getItem('xui_bg') || 'off') === 'on') startVantaGlobe(); } catch(e) {} }
    });
} catch(e) {}

// Modal drag
try {
    const overlay = document.getElementById('modal-overlay');
    const card = overlay?.querySelector('.modal-card');
    const closeIfDragged = (dy) => { if (dy > 140) { closeModal(); try { card.style.transform = ''; } catch(e) {} return true; } return false; };
    if (card && typeof gsap !== 'undefined' && typeof Draggable !== 'undefined') {
        gsap.registerPlugin(Draggable);
        Draggable.create(card, { type: 'x,y', bounds: window, cursor: 'grab', activeCursor: 'grabbing', onDragEnd: function() { const dy = this.y || 0; if (!closeIfDragged(dy)) gsap.to(card, { x: 0, y: 0, duration: 0.18, ease: 'power2.out' }); } });
    } else if (card) {
        let dragging = false, startX = 0, startY = 0, baseX = 0, baseY = 0;
        const onDown = (e) => { if (e.button !== undefined && e.button !== 0) return; dragging = true; const pt = e.touches?.[0] || e; startX = pt.clientX; startY = pt.clientY; const m = (card.style.transform || '').match(/translate\(([-0-9.]+)px,\s*([-0-9.]+)px\)/); baseX = m ? Number(m[1]) : 0; baseY = m ? Number(m[2]) : 0; card.style.cursor = 'grabbing'; e.preventDefault?.(); };
        const onMove = (e) => { if (!dragging) return; const pt = e.touches?.[0] || e; card.style.transform = `translate(${baseX + pt.clientX - startX}px, ${baseY + pt.clientY - startY}px)`; };
        const onUp = () => { if (!dragging) return; dragging = false; card.style.cursor = ''; const m = (card.style.transform || '').match(/translate\(([-0-9.]+)px,\s*([-0-9.]+)px\)/); if (!closeIfDragged(m ? Number(m[2]) : 0)) card.style.transform = ''; };
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
            try { if (bodyText) JSON.parse(bodyText); opts.body = bodyText || '{}'; } catch(e) { respBox.value = 'Invalid JSON body'; return; }
        }
        try {
            const res = await fetch(url, opts);
            const txt = await res.text();
            try { respBox.value = JSON.stringify(JSON.parse(txt), null, 2); } catch(e) { respBox.value = txt; }
        } catch(e) { respBox.value = String(e); }
    });
} catch(e) {}

// --- Admin SSE ---
let __adminEventSource = null, __adminSseRetry = null;

function startAdminSSE() {
    try { __adminEventSource?.close?.(); } catch(e) {}
    __adminEventSource = null;
    const es = new EventSource('/api/stream');
    __adminEventSource = es;
    es.addEventListener('metrics', (ev) => {
        try { const p = JSON.parse(ev.data || '{}'); if (p && p.status) applyAdminStatusToUI(p.status); } catch(e) {}
    });
    es.addEventListener('error', () => {
        try { es.close(); } catch(e) {}
        __adminEventSource = null;
        if (__adminSseRetry) return;
        __adminSseRetry = setInterval(() => { try { clearInterval(__adminSseRetry); } catch(e) {} __adminSseRetry = null; startAdminSSE(); }, 1500);
    });
}

function stopAdminSSE() {
    try { __adminEventSource?.close?.(); } catch(e) {}
    __adminEventSource = null;
    try { clearInterval(__adminSseRetry); } catch(e) {}
    __adminSseRetry = null;
}

function switchTab(tabId) {
    try { document.querySelectorAll('.nav-btn, .m-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId)); } catch(e) {}
    const allTabs = Array.from(document.querySelectorAll('.tab-content'));
    const targetId = `tab-${tabId}`;
    const target = document.getElementById(targetId);
    if (!target) return;
    const currentlyActive = allTabs.find(t => t.classList.contains('active'));
    if (currentlyActive === target) return;
    if (typeof gsap !== 'undefined' && currentlyActive) {
        gsap.to(currentlyActive, { opacity: 0, y: 8, duration: 0.18, ease: 'power2.inOut', onComplete: () => {
            currentlyActive.classList.remove('active'); currentlyActive.style.opacity = ''; currentlyActive.style.transform = '';
            target.classList.add('active');
            gsap.fromTo(target, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.26, ease: 'power2.out' });
        }});
        return;
    }
    if (typeof anime !== 'undefined' && currentlyActive) {
        anime({ targets: currentlyActive, opacity: [1,0], translateY: [0,8], duration: 180, easing: 'easeInOutCubic', complete: () => {
            currentlyActive.classList.remove('active'); currentlyActive.style.opacity = ''; currentlyActive.style.transform = '';
            target.classList.add('active');
            anime({ targets: target, opacity: [0,1], translateY: [14,0], duration: 260, easing: 'easeOutCubic' });
        }});
        return;
    }
    allTabs.forEach(t => t.classList.toggle('active', t.id === targetId));
}

try { document.querySelectorAll('.nav-btn, .m-nav-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab))); } catch(e) {}
try { const sel = document.getElementById('admin-tab-select'); sel?.addEventListener('change', () => switchTab(sel.value)); } catch(e) {}

// --- Admin Charts ---
let trafficChart, donutChart, cpuChart, ramChart;
function initAdminCharts() {
    try { if (typeof Chart === 'undefined') return; } catch(e) { return; }
    const trafficCtx = document.getElementById('trafficChart')?.getContext?.('2d');
    if (!trafficCtx) return;
    trafficChart = new Chart(trafficCtx, { type: 'line', data: { labels: ['M','T','W','T','F','S','S'], datasets: [{ label: 'Down', data: [5,8,4,7,9,12,10], borderColor: '#0066ff', tension: 0.4, fill: true, backgroundColor: 'rgba(0,102,255,0.05)' }, { label: 'Up', data: [2,3,2,4,3,5,4], borderColor: '#00ffcc', tension: 0.4, fill: true, backgroundColor: 'rgba(0,255,204,0.05)' }]}, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#555' } } } }});
    const donutCtx = document.getElementById('usageDonut')?.getContext?.('2d');
    if (donutCtx) donutChart = new Chart(donutCtx, { type: 'doughnut', data: { datasets: [{ data: [70,30], backgroundColor: ['#0066ff','#00ffcc'], borderWidth: 0 }] }, options: { cutout: '80%', plugins: { tooltip: { enabled: false } } }});
    const cpuCtx = document.getElementById('cpuChart')?.getContext?.('2d');
    if (cpuCtx) cpuChart = new Chart(cpuCtx, { type: 'line', data: { labels: Array(10).fill(''), datasets: [{ data: Array(10).fill(0), borderColor: '#00ffcc', borderWidth: 2, pointRadius: 0, tension: 0.4 }]}, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }});
    const ramCtx = document.getElementById('ramChart')?.getContext?.('2d');
    if (ramCtx) ramChart = new Chart(ramCtx, { type: 'line', data: { labels: Array(10).fill(''), datasets: [{ data: Array(10).fill(0), borderColor: '#0066ff', borderWidth: 2, pointRadius: 0, tension: 0.4 }]}, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }});
}

function applyAdminStatusToUI(stat) {
    if (!stat || !stat.success) return;
    const s = stat.obj;
    const down = toGB((s.netTraffic && (s.netTraffic.down ?? s.netTraffic.recv)) ?? s.netIO?.down);
    const up = toGB((s.netTraffic && (s.netTraffic.up ?? s.netTraffic.sent)) ?? s.netIO?.up);
    const total = (parseFloat(down) + parseFloat(up)).toFixed(2);
    try { animateNumber('#total-traffic', Number(total), { decimals: 2, duration: 650 }); animateNumber('#dl-traffic', Number(down), { decimals: 2, duration: 650 }); animateNumber('#up-traffic', Number(up), { decimals: 2, duration: 650 }); } catch(e) {}
    const cpuPct = Math.max(0, Math.min(100, Number.isFinite(Number(s.cpu)) ? Number(s.cpu) : 0));
    animateNumber('#cpu-percent', cpuPct, { decimals: 1, duration: 500, formatter: (v) => `${Number(v).toFixed(1)}%` });
    const memCur = Number(s.mem?.current), memTot = Number(s.mem?.total);
    const ramPct = (Number.isFinite(memCur) && Number.isFinite(memTot) && memTot > 0) ? Math.max(0, Math.min(100, (memCur / memTot) * 100)) : 0;
    animateNumber('#ram-percent', ramPct, { decimals: 1, duration: 500, formatter: (v) => `${Number(v).toFixed(1)}%` });
    try { document.getElementById('node-ip').textContent = s.publicIP?.ipv4 || s.publicIP?.ipv6 || '-'; document.getElementById('node-region').textContent = s.publicIP?.country || '-'; document.getElementById('xray-version').textContent = s.xray?.version || '-'; } catch(e) {}
    try { if (donutChart?.data?.datasets?.[0]) { donutChart.data.datasets[0].data = [Number(down), Number(up)]; donutChart.update(); } } catch(e) {}
}

// --- Expiry Alerts ---
async function loadExpiryAlerts() {
    try {
        const r = await fetch('/api/expiry-alerts', { headers: getAdminHeaders() });
        const data = await r.json();
        if (data.success) renderExpiryAlerts(data.obj || []);
    } catch(e) {}
}

function renderExpiryAlerts(alerts) {
    const card = document.getElementById('expiry-alerts-card');
    const list = document.getElementById('expiry-alerts-list');
    const countEl = document.getElementById('expiry-alert-count');
    if (!alerts || !alerts.length) { if (card) card.style.display = 'none'; return; }
    if (card) card.style.display = 'block';
    if (countEl) countEl.textContent = `${alerts.length} client${alerts.length !== 1 ? 's' : ''}`;
    if (!list) return;
    list.innerHTML = '';
    alerts.forEach(a => {
        const expired = a.daysLeft <= 0;
        const color = expired ? 'var(--red)' : a.daysLeft <= 7 ? 'orange' : 'var(--accent)';
        const label = expired ? 'Expired' : `${a.daysLeft}d left`;
        const el = document.createElement('div');
        el.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid rgba(255,255,255,0.06);';
        el.innerHTML = `<div><div style="font-weight:600;font-size:0.9rem;">${a.email}</div><div style="font-size:0.78rem;color:var(--text-dim);">${a.inboundRemark}</div></div><div style="text-align:right;"><div style="font-weight:700;color:${color};font-size:0.9rem;">${label}</div><div style="font-size:0.75rem;color:var(--text-dim);">${new Date(a.expiryTime).toLocaleDateString()}</div></div>`;
        list.appendChild(el);
    });
}

// --- Load Admin Data ---
async function loadAdminData() {
    try {
        window.__lastAdminUpdate = Date.now();
        try { const dot = document.querySelector('.user-status .status-dot'); if (dot) dot.classList.add('online'); } catch(e) {}

        const [stat, inb, cli, sys] = await Promise.all([
            fetch('/api/status', {headers: getAdminHeaders()}).then(r => r.json()),
            fetch('/api/inbounds', {headers: getAdminHeaders()}).then(r => r.json()),
            fetch('/api/clients', {headers: getAdminHeaders()}).then(r => r.json()),
            fetch('/api/system-history', {headers: getAdminHeaders()}).then(r => r.json())
        ]);

        applyAdminStatusToUI(stat);
        loadExpiryAlerts();

        if (inb.success) {
            window.__inboundsCache = inb.obj || [];
            try {
                const sel = document.getElementById('addc-inbound');
                const delSel = document.getElementById('del-inbound-sel');
                if (sel) {
                    sel.innerHTML = '';
                    (inb.obj || []).forEach(node => {
                        const opt = document.createElement('option');
                        opt.value = node.id;
                        opt.textContent = `${node.remark || 'inbound-' + node.id} • ${(node.protocol || '').toUpperCase()} • :${node.port}`;
                        sel.appendChild(opt);
                    });
                }
                if (delSel) {
                    delSel.innerHTML = '';
                    (inb.obj || []).forEach(node => {
                        const opt = document.createElement('option');
                        opt.value = node.id;
                        opt.textContent = `${node.remark || 'inbound-' + node.id} • :${node.port}`;
                        delSel.appendChild(opt);
                    });
                }
            } catch(e) {}

            const container = document.getElementById('inbound-cards-container');
            container.innerHTML = '';
            (inb.obj || []).forEach(node => {
                const div = document.createElement('div');
                div.className = 'card item-card reveal';
                div.style.cssText = 'opacity:0;transform:translateY(14px);';
                div.innerHTML = `<div class="item-header"><div><strong style="font-size:1.1rem">${node.remark || ''}</strong><p class="subtitle" style="margin:0">${(node.protocol||'').toUpperCase()} • Port ${node.port}</p></div><div class="status-badge ${node.enable ? 'active' : ''}">${node.enable ? 'Online' : 'Off'}</div></div><div class="item-stats"><div class="stat-box"><span class="label">DOWN</span><span class="val">${toGB(node.down)} GB</span></div><div class="stat-box"><span class="label">UP</span><span class="val">${toGB(node.up)} GB</span></div><div class="stat-box"><span class="label">USERS</span><span class="val">${node.clientStats?.length ?? 0}</span></div></div>`;
                container.appendChild(div);
            });

            try {
                const els = container.querySelectorAll('.reveal');
                if (typeof gsap !== 'undefined') gsap.to(els, { opacity: 1, y: 0, duration: 0.35, stagger: 0.03, ease: 'power2.out' });
                else if (typeof anime !== 'undefined') anime({ targets: els, opacity: [0,1], translateY: [14,0], delay: anime.stagger(30), duration: 350, easing: 'easeOutCubic' });
                else els.forEach(el => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
            } catch(e) {}
        }

        if (cli.success) { __clientsCache = Array.isArray(cli.obj) ? cli.obj : []; renderClientsList(__clientsCache); }

        if (sys.success) {
            try {
                if (cpuChart?.data?.datasets?.[0]) { cpuChart.data.datasets[0].data = sys.obj.map(p => p.cpu || 0); cpuChart.update(); }
                if (ramChart?.data?.datasets?.[0]) { ramChart.data.datasets[0].data = sys.obj.map(p => p.ram || 0); ramChart.update(); }
            } catch(e) {}
        }

    } catch(e) {
        console.error("Data Load Error", e);
        try {
            const dot = document.querySelector('.user-status .status-dot');
            if (dot) { dot.classList.remove('online'); dot.style.background = 'var(--red)'; dot.style.boxShadow = '0 0 10px var(--red)'; }
        } catch(e2) {}
        try { showToast('Connection error while loading data', 'error'); } catch(e3) {}
    }
}

// --- Render Clients List (with bulk checkboxes) ---
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
        const emailSafe = String(user.email || '').replace(/"/g, '&quot;');
        const isSelected = __bulkSelected.has(user.email);
        const div = document.createElement('div');
        div.className = 'card item-card reveal';
        div.setAttribute('data-client-email', emailSafe);
        div.style.cssText = 'margin-bottom:10px;opacity:0;transform:translateY(14px);cursor:pointer;';
        div.innerHTML = `
            <div class="item-header" style="margin:0">
                <div style="display:flex;align-items:center;gap:10px;">
                    <input type="checkbox" class="bulk-check" data-email="${emailSafe}" ${isSelected ? 'checked' : ''} style="width:17px;height:17px;cursor:pointer;flex-shrink:0;" onclick="event.stopPropagation()">
                    <i class="fa-solid fa-circle-user" style="font-size:1.4rem;color:var(--blue)"></i>
                    <div>
                        <strong>${user.email}</strong>
                        <p class="subtitle" style="margin:0;font-size:0.78rem;">Limit: ${limitTxt} ${user.enable === false ? '• <span style="color:var(--red)">Disabled</span>' : ''}</p>
                    </div>
                </div>
                <div class="stat-box" style="text-align:right"><span class="label">USED</span><span class="val" style="color:var(--accent)">${used} GB</span></div>
            </div>`;
        container.appendChild(div);
    });

    try {
        const els = container.querySelectorAll('.reveal');
        if (typeof gsap !== 'undefined') gsap.to(els, { opacity: 1, y: 0, duration: 0.35, stagger: 0.02, ease: 'power2.out' });
        else if (typeof anime !== 'undefined') anime({ targets: els, opacity: [0,1], translateY: [14,0], delay: anime.stagger(20), duration: 320, easing: 'easeOutCubic' });
        else els.forEach(el => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
    } catch(e) {}

    // wire bulk checkboxes
    container.querySelectorAll('.bulk-check').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const em = cb.getAttribute('data-email');
            if (cb.checked) __bulkSelected.add(em); else __bulkSelected.delete(em);
            updateBulkUI();
        });
    });
}

function updateBulkUI() {
    const count = __bulkSelected.size;
    const countEl = document.getElementById('bulk-count');
    const resetBtn = document.getElementById('btn-bulk-reset');
    const delBtn = document.getElementById('btn-bulk-delete');
    if (countEl) { countEl.textContent = `${count} selected`; countEl.style.display = count > 0 ? 'inline' : 'none'; }
    if (resetBtn) resetBtn.style.display = count > 0 ? 'inline-flex' : 'none';
    if (delBtn) delBtn.style.display = count > 0 ? 'inline-flex' : 'none';
}

// Bulk select all
try {
    document.getElementById('bulk-select-all')?.addEventListener('change', (e) => {
        const checked = e.target.checked;
        const term = (__clientSearchTerm || '').toLowerCase();
        const filtered = (__clientsCache || []).filter(u => {
            const email = String(u.email || '').toLowerCase();
            return !term || email.includes(term);
        });
        filtered.forEach(u => { if (checked) __bulkSelected.add(u.email); else __bulkSelected.delete(u.email); });
        renderClientsList(__clientsCache);
        updateBulkUI();
    });
} catch(e) {}

try {
    document.getElementById('btn-bulk-reset')?.addEventListener('click', async () => {
        if (!__bulkSelected.size) return;
        if (!confirm(`Reset traffic for ${__bulkSelected.size} client(s)?`)) return;
        let done = 0;
        for (const email of __bulkSelected) {
            const user = __clientsCache.find(u => u.email === email);
            if (!user) continue;
            try { await callXui(`inbounds/${user.inboundId}/resetClientTraffic/${encodeURIComponent(email)}`, 'POST', {}); done++; } catch(e) {}
        }
        showToast(`Reset traffic for ${done} client(s)`);
        __bulkSelected.clear();
        updateBulkUI();
        loadAdminData();
    });

    document.getElementById('btn-bulk-delete')?.addEventListener('click', async () => {
        if (!__bulkSelected.size) return;
        if (!confirm(`DELETE ${__bulkSelected.size} client(s)? This cannot be undone.`)) return;
        let done = 0;
        for (const email of __bulkSelected) {
            const user = __clientsCache.find(u => u.email === email);
            if (!user) continue;
            try { await callXui(`inbounds/${user.inboundId}/delClientByEmail/${encodeURIComponent(email)}`, 'POST', {}); done++; } catch(e) {}
        }
        showToast(`Deleted ${done} client(s)`);
        __bulkSelected.clear();
        updateBulkUI();
        loadAdminData();
    });
} catch(e) {}

// --- Client Drawer ---
function getClientUUID(inboundId, email) {
    const inb = (window.__inboundsCache || []).find(x => Number(x.id) === Number(inboundId));
    if (!inb) return null;
    try { const s = JSON.parse(inb.settings || '{}'); return (s.clients || []).find(c => c.email === email)?.id || null; } catch(e) { return null; }
}

function getClientFullConfig(inboundId, email) {
    const inb = (window.__inboundsCache || []).find(x => Number(x.id) === Number(inboundId));
    if (!inb) return null;
    try { const s = JSON.parse(inb.settings || '{}'); return (s.clients || []).find(c => c.email === email) || null; } catch(e) { return null; }
}

function openClientDrawer(user) {
    const wrap = document.getElementById('client-drawer');
    const backdrop = document.getElementById('drawer-backdrop');
    const panel = wrap?.querySelector('.drawer-panel');
    if (!wrap || !backdrop || !panel) return;

    document.getElementById('drawer-title').textContent = user.email || 'Client';
    document.getElementById('drawer-sub').textContent = user.inboundRemark || String(user.inboundId || '');

    const used = toGB((user.up || 0) + (user.down || 0));
    const down = toGB(user.down || 0);
    const up = toGB(user.up || 0);
    const limit = user.total > 0 ? `${toGB(user.total)} GB` : 'Unlimited';
    const exp = Number(user.expiryTime);
    const expText = exp > 0 ? new Date(exp).toLocaleString() : 'Never';
    const uuid = getClientUUID(user.inboundId, user.email) || '-';
    const protocol = user.protocol || '-';

    const body = document.getElementById('drawer-body');
    if (body) {
        body.innerHTML = `
            <div class="card" style="padding:14px;">
                <h3 style="margin-bottom:10px;"><i class="fa-solid fa-chart-simple"></i> Usage</h3>
                <div class="info-row"><span>Used:</span><strong>${used} GB</strong></div>
                <div class="info-row"><span>Download:</span><strong>${down} GB</strong></div>
                <div class="info-row"><span>Upload:</span><strong>${up} GB</strong></div>
                <div class="info-row"><span>Limit:</span><strong>${limit}</strong></div>
                <div class="info-row"><span>Expiry:</span><strong>${expText}</strong></div>
                <div class="info-row"><span>Protocol:</span><strong>${protocol.toUpperCase()}</strong></div>
                <div class="info-row"><span>UUID:</span><strong style="font-size:0.78rem;word-break:break-all;">${uuid}</strong></div>
                <div class="info-row"><span>Status:</span><strong style="color:${user.enable === false ? 'var(--red)' : 'var(--green)'}">${user.enable === false ? 'Disabled' : 'Enabled'}</strong></div>
            </div>
            <div id="drawer-traffic-history" style="display:none;" class="card" style="padding:14px; margin-top:8px;"></div>`;
    }

    // Wire buttons
    document.getElementById('drawer-reset').onclick = () => {
        const tool = document.getElementById('tool-email');
        const inbSel = document.getElementById('addc-inbound');
        if (tool) tool.value = user.email || '';
        if (inbSel) inbSel.value = user.inboundId;
        closeClientDrawer();
        document.getElementById('btn-client-reset')?.click();
    };
    document.getElementById('drawer-delete').onclick = () => {
        const tool = document.getElementById('tool-email');
        const inbSel = document.getElementById('addc-inbound');
        if (tool) tool.value = user.email || '';
        if (inbSel) inbSel.value = user.inboundId;
        closeClientDrawer();
        document.getElementById('btn-client-del')?.click();
    };
    document.getElementById('drawer-edit').onclick = () => { closeClientDrawer(); openEditClientModal(user); };
    document.getElementById('drawer-toggle-enable').onclick = async () => {
        const fullConf = getClientFullConfig(user.inboundId, user.email);
        if (!fullConf) { showToast('Cannot find client config in cache', 'error'); return; }
        const r = await callXui(`inbounds/updateClient/${fullConf.id}`, 'POST', {
            id: user.inboundId,
            settings: { clients: [{ ...fullConf, enable: !fullConf.enable }] }
        });
        showToast(r && r.success !== false ? `Client ${!fullConf.enable ? 'enabled' : 'disabled'}` : (r?.msg || 'Failed'), r && r.success !== false ? 'info' : 'error');
        closeClientDrawer();
        loadAdminData();
    };

    wrap.style.display = 'block';
    wrap.setAttribute('aria-hidden', 'false');

    try {
        if (typeof gsap !== 'undefined') { gsap.to(backdrop, { opacity: 1, duration: 0.2 }); gsap.to(panel, { x: 0, duration: 0.28, ease: 'power2.out' }); }
        else if (typeof anime !== 'undefined') { anime({ targets: backdrop, opacity: [0,1], duration: 200, easing: 'linear' }); anime({ targets: panel, translateX: ['110%','0%'], duration: 280, easing: 'easeOutCubic' }); }
        else { backdrop.style.opacity = '1'; panel.style.transform = 'translateX(0)'; }
    } catch(e) {}
}

function closeClientDrawer() {
    const wrap = document.getElementById('client-drawer');
    const backdrop = document.getElementById('drawer-backdrop');
    const panel = wrap?.querySelector('.drawer-panel');
    if (!wrap || !backdrop || !panel) return;
    const done = () => { wrap.style.display = 'none'; wrap.setAttribute('aria-hidden', 'true'); backdrop.style.opacity = '0'; panel.style.transform = ''; };
    try {
        if (typeof gsap !== 'undefined') { gsap.to(backdrop, { opacity: 0, duration: 0.18 }); gsap.to(panel, { x: '110%', duration: 0.22, ease: 'power2.in', onComplete: done }); return; }
        if (typeof anime !== 'undefined') { anime({ targets: backdrop, opacity: [1,0], duration: 180, easing: 'linear' }); anime({ targets: panel, translateX: ['0%','110%'], duration: 220, easing: 'easeInCubic', complete: done }); return; }
    } catch(e) {}
    done();
}

try {
    const inp = document.getElementById('client-search');
    inp?.addEventListener('input', () => { __clientSearchTerm = inp.value || ''; renderClientsList(__clientsCache); });
    document.getElementById('client-list')?.addEventListener('click', (e) => {
        if (e.target?.classList?.contains('bulk-check')) return;
        const card = e.target?.closest?.('[data-client-email]');
        if (!card) return;
        const email = card.getAttribute('data-client-email');
        const user = (__clientsCache || []).find(u => String(u.email) === String(email));
        if (user) openClientDrawer(user);
    });
    document.getElementById('drawer-close')?.addEventListener('click', closeClientDrawer);
    document.getElementById('drawer-backdrop')?.addEventListener('click', closeClientDrawer);
} catch(e) {}

// --- Settings ---
document.getElementById("btn-save-settings").addEventListener("click", async () => {
    const btn = document.getElementById("btn-save-settings");
    showToast("Configured via Cloudflare Pages environment variables.", "error");
    btn.textContent = "Managed by Cloudflare"; btn.disabled = true; btn.style.opacity = '0.7'; btn.style.cursor = 'not-allowed';
});

// --- Server Tools ---
function setServerOutput(val) {
    try { const el = document.getElementById('server-output'); if (el) el.value = typeof val === 'string' ? val : JSON.stringify(val, null, 2); } catch(e) {}
}

async function callXui(path, method='GET', bodyObj=null) {
    const url = `/api/xui/${path.replace(/^\/+/, '')}`;
    const opts = { method, headers: getAdminHeaders() };
    if (method === 'POST') { opts.headers = { ...opts.headers, 'Content-Type': 'application/json' }; opts.body = JSON.stringify(bodyObj ?? {}); }
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
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function wireServerTools() {
    const byId = (id) => document.getElementById(id);

    byId('btn-xray-restart')?.addEventListener('click', async () => { setServerOutput('Restarting Xray...'); const r = await callXui('server/restartXrayService', 'POST', {}); setServerOutput(r); loadAdminData(); });
    byId('btn-xray-stop')?.addEventListener('click', async () => { setServerOutput('Stopping Xray...'); const r = await callXui('server/stopXrayService', 'POST', {}); setServerOutput(r); loadAdminData(); });
    byId('btn-geo-update')?.addEventListener('click', async () => { setServerOutput('Updating geo files...'); const r = await callXui('server/updateGeofile', 'POST', {}); setServerOutput(r); });
    byId('btn-dl-config')?.addEventListener('click', async () => { setServerOutput('Downloading config.json...'); await downloadFromXui('server/getConfigJson', 'config.json'); setServerOutput('Downloaded config.json'); });
    byId('btn-dl-db')?.addEventListener('click', async () => { setServerOutput('Downloading database...'); await downloadFromXui('server/getDb', 'x-ui.db'); setServerOutput('Downloaded x-ui.db'); });
    byId('btn-new-uuid')?.addEventListener('click', async () => {
        try { const r = await callXui('server/getNewUUID', 'GET'); const u = extractUuid(r) || uuidFallback(); setServerOutput({ raw: r, uuid: u }); }
        catch(e) { setServerOutput({ error: String(e), uuid: uuidFallback() }); }
    });
    byId('btn-new-x25519')?.addEventListener('click', async () => { const r = await callXui('server/getNewX25519Cert', 'GET'); setServerOutput(r); });

    const getCount = () => Number(byId('log-count')?.value || 200);
    byId('btn-logs')?.addEventListener('click', async () => { const r = await callXui(`server/logs/${getCount()}`, 'POST', { level: 'info', syslog: false }); setServerOutput(r); });
    byId('btn-xray-logs')?.addEventListener('click', async () => { const r = await callXui(`server/xraylogs/${getCount()}`, 'POST', { filter: '', level: 'info' }); setServerOutput(r); });

    // Import DB
    byId('btn-import-db')?.addEventListener('click', async () => {
        const fileInput = byId('import-db-file');
        const file = fileInput?.files?.[0];
        if (!file) { showToast('Select a .db file first', 'error'); return; }
        setServerOutput('Uploading database...');
        try {
            const form = new FormData();
            form.append('file', file);
            const url = '/api/xui/server/importDB';
            const headers = { ...getAdminHeaders() };
            delete headers['Content-Type']; // let browser set multipart boundary
            const res = await fetch(url, { method: 'POST', headers, body: form });
            const txt = await res.text();
            try { setServerOutput(JSON.parse(txt)); } catch(e) { setServerOutput(txt); }
            showToast('Database imported — panel will restart');
        } catch(e) { setServerOutput(`Error: ${e.message}`); showToast('Import failed', 'error'); }
    });
}

try { wireServerTools(); } catch(e) {}

// --- Link Building (multi-protocol) ---
function buildLinksForClient(inbound, client) {
    try {
        const host = window.location.hostname.replace(/^www\./, '');
        const stream = JSON.parse(inbound.streamSettings || '{}');
        const port = inbound.port;
        const remark = inbound.remark || String(port);
        const network = stream.network || 'tcp';
        const security = stream.security || 'none';
        const protocol = (inbound.protocol || 'vless').toLowerCase();
        const subLink = client.subId ? null : null; // panel sub URL not known client-side

        const buildQs = () => {
            let qs = new URLSearchParams();
            qs.set('type', network);
            if (network === 'ws') {
                const ws = stream.wsSettings || {};
                qs.set('path', ws.path || '/');
                qs.set('host', ws.headers?.Host || ws.host || host);
            } else if (network === 'grpc') {
                const grpc = stream.grpcSettings || {};
                qs.set('serviceName', grpc.serviceName || '');
                qs.set('mode', grpc.multiMode ? 'multi' : 'gun');
            }
            if (security === 'tls') {
                qs.set('security', 'tls');
                const tls = stream.tlsSettings || {};
                qs.set('sni', tls.serverName || host);
                const alpn = Array.isArray(tls.alpn) ? tls.alpn.join(',') : '';
                if (alpn) qs.set('alpn', alpn);
                const fp = tls.settings?.fingerprint || '';
                if (fp) qs.set('fp', fp);
            } else if (security === 'reality') {
                qs.set('security', 'reality');
                const r = stream.realitySettings || {};
                qs.set('sni', (r.serverNames || [])[0] || host);
                qs.set('pbk', r.publicKey || '');
                if (r.shortIds?.[0]) qs.set('sid', r.shortIds[0]);
                qs.set('fp', r.settings?.fingerprint || 'chrome');
            }
            return qs;
        };

        let configLink = null;
        if (protocol === 'vless') {
            const qs = buildQs();
            qs.set('encryption', 'none');
            if (client.flow) qs.set('flow', client.flow);
            configLink = `vless://${client.id}@${host}:${port}?${qs.toString()}#${encodeURIComponent(`${remark}-${client.email}`)}`;
        } else if (protocol === 'vmess') {
            const obj = { v:'2', ps:`${remark}-${client.email}`, add:host, port:String(port), id:client.id, aid:'0', scy:'auto', net:network, type:'none', host: network==='ws'?(stream.wsSettings?.headers?.Host||host):'', path: network==='ws'?(stream.wsSettings?.path||'/'):'', tls: security==='tls'?'tls':'' };
            configLink = `vmess://${btoa(JSON.stringify(obj))}`;
        } else if (protocol === 'trojan') {
            const qs = buildQs();
            configLink = `trojan://${client.password || client.id}@${host}:${port}?${qs.toString()}#${encodeURIComponent(`${remark}-${client.email}`)}`;
        } else if (protocol === 'shadowsocks') {
            try {
                const settings = JSON.parse(inbound.settings || '{}');
                const method = settings.method || 'aes-256-gcm';
                const password = client.password || settings.password || '';
                const userInfo = btoa(`${method}:${password}`);
                configLink = `ss://${userInfo}@${host}:${port}#${encodeURIComponent(`${remark}-${client.email}`)}`;
            } catch(e2) { configLink = null; }
        }

        return { configLink, subLink };
    } catch(e) {
        return { configLink: null, subLink: null };
    }
}

function extractUuid(val) {
    try {
        if (!val) return null;
        if (typeof val === 'string') return val.trim();
        const cand = val.obj || val.uuid || val.data || val.result;
        if (typeof cand === 'string') return cand.trim();
        if (cand && typeof cand === 'object') { const nested = cand.uuid || cand.id; if (typeof nested === 'string') return nested.trim(); }
        return null;
    } catch(e) { return null; }
}

function uuidFallback() {
    try { if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID(); } catch(e) {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random()*16|0; return (c==='x'?r:(r&0x3|0x8)).toString(16); });
}

// --- Add Client (multi-protocol aware) ---
async function addClient() {
    const out = document.getElementById('addc-result');
    const uiCard = document.getElementById('ui-result');
    const uiBody = document.getElementById('ui-result-body');
    const inboundId = Number(document.getElementById('addc-inbound')?.value);
    const email = document.getElementById('addc-email')?.value?.trim();
    const limitGb = Number(document.getElementById('addc-limit')?.value || 0);
    const days = Number(document.getElementById('addc-days')?.value || 0);
    const ipLimit = Number(document.getElementById('addc-iplimit')?.value || 0);

    if (!email) { showToast('Enter client email/ID', 'error'); return; }
    if (!inboundId) { showToast('Select inbound', 'error'); return; }

    if (uiCard) uiCard.style.display = 'block';
    if (uiBody) uiBody.innerHTML = '<div style="color:var(--text-dim)">Creating...</div>';
    if (out) out.value = 'Creating client...';

    const inbound = (window.__inboundsCache || []).find(x => Number(x.id) === inboundId);
    const protocol = (inbound?.protocol || 'vless').toLowerCase();

    let clientId = null;
    try { const uuidRes = await callXui('server/getNewUUID', 'GET'); clientId = extractUuid(uuidRes); } catch(e) {}
    if (!clientId) { clientId = uuidFallback(); showToast('UUID endpoint failed — used local UUID', 'info'); }

    const subId = Math.random().toString(36).slice(2, 18);
    const expiryTime = days > 0 ? (Date.now() + days * 24 * 60 * 60 * 1000) : 0;
    const totalGB = limitGb > 0 ? Math.floor(limitGb * (1024 ** 3)) : 0;

    let clientSettings;
    if (protocol === 'trojan') {
        clientSettings = { password: clientId, email, enable: true, expiryTime, limitIp: ipLimit, subId, totalGB, tgId: '' };
    } else if (protocol === 'shadowsocks') {
        clientSettings = { password: uuidFallback(), email, enable: true, expiryTime, limitIp: ipLimit, subId, totalGB };
    } else {
        // vless / vmess
        clientSettings = { id: clientId, email, enable: true, expiryTime, limitIp: ipLimit, reset: 0, subId, totalGB, flow: '', tgId: '' };
    }

    const payload = { id: inboundId, settings: { clients: [clientSettings] } };
    const res = await callXui('inbounds/addClient', 'POST', payload);

    const links = inbound ? buildLinksForClient(inbound, { id: clientId, email, subId, flow: '' }) : { configLink: null, subLink: null };

    if (out) out.value = JSON.stringify({ api: res, configLink: links.configLink }, null, 2);

    if (uiBody) {
        uiBody.innerHTML = '';
        const ok = res && (res.success === true || res.msg === 'success');
        const addRow = (k, v) => { const d = document.createElement('div'); d.className='kv'; d.innerHTML=`<div class="k">${k}</div><div class="v">${v}</div>`; uiBody.appendChild(d); };
        addRow('Status', `<span style="color:${ok?'var(--green)':'var(--accent)'}">${ok?'Created':'Check response'}</span>`);
        addRow('Protocol', protocol.toUpperCase());
        addRow('Email', email);

        if (ok && links.configLink) {
            const wrap = document.createElement('div');
            wrap.innerHTML = '<div style="font-size:0.8rem;color:var(--text-dim);margin-bottom:6px;">Config Link</div>';
            const row = document.createElement('div'); row.className = 'copy-row';
            const inp = document.createElement('input'); inp.value = links.configLink; inp.readOnly = true; inp.style.fontSize = '0.78rem';
            const btn = document.createElement('button'); btn.className = 'sys-btn'; btn.textContent = 'Copy';
            btn.addEventListener('click', async () => { try { await navigator.clipboard.writeText(links.configLink); showToast('Copied'); } catch(e) { showToast('Copy failed','error'); } });
            row.appendChild(inp); row.appendChild(btn); wrap.appendChild(row);

            // QR code
            const qrWrap = document.createElement('div'); qrWrap.style.cssText = 'margin-top:12px;display:flex;justify-content:center;';
            const qrCanvas = document.createElement('canvas'); qrCanvas.style.cssText = 'border-radius:8px;background:#fff;padding:8px;';
            qrWrap.appendChild(qrCanvas); wrap.appendChild(qrWrap);
            uiBody.appendChild(wrap);
            setTimeout(() => generateQR(links.configLink, qrCanvas, 180), 50);
        }
    }
    if (uiCard) uiCard.style.display = 'block';
    showToast(res?.success !== false ? 'Client created' : (res?.msg || 'Failed'), res?.success !== false ? 'info' : 'error');
    loadAdminData();
}

// --- Edit Client Modal ---
window.closeEditClientModal = function() {
    const m = document.getElementById('edit-client-modal');
    if (m) m.style.display = 'none';
};

function openEditClientModal(user) {
    const m = document.getElementById('edit-client-modal');
    if (!m) return;

    const fullConf = getClientFullConfig(user.inboundId, user.email);
    if (!fullConf) { showToast('Client config not found in cache — refresh data first', 'error'); return; }

    document.getElementById('edit-client-uuid').value = fullConf.id || '';
    document.getElementById('edit-client-inbound-id').value = user.inboundId || '';
    document.getElementById('edit-client-email').value = fullConf.email || '';
    document.getElementById('edit-client-limit').value = fullConf.totalGB > 0 ? Math.round(fullConf.totalGB / (1024**3)) : 0;
    document.getElementById('edit-client-iplimit').value = fullConf.limitIp || 0;
    document.getElementById('edit-client-enable').checked = fullConf.enable !== false;

    const expEl = document.getElementById('edit-client-expiry');
    if (expEl) {
        const exp = Number(fullConf.expiryTime);
        if (exp > 0) {
            const d = new Date(exp);
            const pad = n => String(n).padStart(2,'0');
            expEl.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        } else { expEl.value = ''; }
    }

    document.getElementById('edit-client-result').textContent = '';
    m.style.display = 'flex';

    document.getElementById('btn-edit-client-save').onclick = async () => {
        const uuid = document.getElementById('edit-client-uuid').value;
        const inboundId = Number(document.getElementById('edit-client-inbound-id').value);
        const email = document.getElementById('edit-client-email').value.trim();
        const limitGb = Number(document.getElementById('edit-client-limit').value || 0);
        const ipLimit = Number(document.getElementById('edit-client-iplimit').value || 0);
        const enable = document.getElementById('edit-client-enable').checked;
        const expVal = document.getElementById('edit-client-expiry').value;
        const expiryTime = expVal ? new Date(expVal).getTime() : 0;
        const totalGB = limitGb > 0 ? Math.floor(limitGb * (1024**3)) : 0;

        const updated = { ...fullConf, email, enable, expiryTime, limitIp: ipLimit, totalGB };
        const r = await callXui(`inbounds/updateClient/${uuid}`, 'POST', { id: inboundId, settings: { clients: [updated] } });
        const ok = r && r.success !== false;
        document.getElementById('edit-client-result').textContent = ok ? 'Saved successfully.' : (r?.msg || 'Failed');
        document.getElementById('edit-client-result').style.color = ok ? 'var(--green)' : 'var(--red)';
        showToast(ok ? 'Client updated' : (r?.msg || 'Update failed'), ok ? 'info' : 'error');
        if (ok) { setTimeout(closeEditClientModal, 800); loadAdminData(); }
    };
}

// --- Add Inbound Modal ---
window.closeAddInboundModal = function() {
    const m = document.getElementById('add-inbound-modal');
    if (m) m.style.display = 'none';
};

function buildInboundPayload() {
    const remark = document.getElementById('new-inbound-remark')?.value?.trim() || 'new-inbound';
    const protocol = document.getElementById('new-inbound-protocol')?.value || 'vless';
    const port = Number(document.getElementById('new-inbound-port')?.value || 0);
    const network = document.getElementById('new-inbound-network')?.value || 'tcp';
    const security = document.getElementById('new-inbound-security')?.value || 'none';

    const streamSettings = { network, security };
    if (network === 'ws') streamSettings.wsSettings = { path: '/', headers: {} };
    if (network === 'grpc') streamSettings.grpcSettings = { serviceName: '' };
    if (security === 'tls') streamSettings.tlsSettings = { serverName: '', alpn: ['h2','http/1.1'], certificates: [] };
    if (security === 'reality') streamSettings.realitySettings = { show: false, dest: 'example.com:443', xver: 0, serverNames: ['example.com'], privateKey: '', shortIds: [''] };

    let settings;
    if (protocol === 'vless') settings = { clients: [], decryption: 'none', fallbacks: [] };
    else if (protocol === 'vmess') settings = { clients: [], disableInsecureEncryption: false };
    else if (protocol === 'trojan') settings = { clients: [], fallbacks: [] };
    else if (protocol === 'shadowsocks') settings = { method: 'aes-256-gcm', password: uuidFallback(), network: 'tcp', clients: [] };

    return {
        up: 0, down: 0, total: 0, remark, enable: true, expiryTime: 0, listen: '', port, protocol,
        settings: JSON.stringify(settings),
        streamSettings: JSON.stringify(streamSettings),
        sniffing: JSON.stringify({ enabled: true, destOverride: ['http','tls'] }),
        tag: `inbound-${port}`
    };
}

try {
    document.getElementById('btn-add-inbound')?.addEventListener('click', () => {
        const m = document.getElementById('add-inbound-modal');
        if (m) m.style.display = 'flex';
        document.getElementById('add-inbound-result').textContent = '';
    });

    document.getElementById('btn-add-inbound-save')?.addEventListener('click', async () => {
        const payload = buildInboundPayload();
        if (!payload.port) { showToast('Enter a port number', 'error'); return; }
        document.getElementById('add-inbound-result').textContent = 'Creating...';
        const r = await callXui('inbounds/add', 'POST', payload);
        const ok = r && r.success !== false;
        document.getElementById('add-inbound-result').textContent = ok ? 'Inbound created!' : (r?.msg || 'Failed');
        document.getElementById('add-inbound-result').style.color = ok ? 'var(--green)' : 'var(--red)';
        showToast(ok ? 'Inbound created' : (r?.msg || 'Failed'), ok ? 'info' : 'error');
        if (ok) { setTimeout(closeAddInboundModal, 800); loadAdminData(); }
    });
} catch(e) {}

// Delete inbound
try {
    document.getElementById('btn-del-inbound')?.addEventListener('click', () => {
        const row = document.getElementById('del-inbound-row');
        if (row) row.style.display = row.style.display === 'none' ? 'block' : 'none';
    });

    document.getElementById('btn-del-inbound-confirm')?.addEventListener('click', async () => {
        const sel = document.getElementById('del-inbound-sel');
        const id = sel?.value;
        if (!id) { showToast('Select an inbound', 'error'); return; }
        const name = sel.options[sel.selectedIndex]?.text || id;
        if (!confirm(`Delete inbound "${name}"? All client configs in this inbound will be lost.`)) return;
        const r = await callXui(`inbounds/del/${id}`, 'POST', {});
        showToast(r?.success !== false ? 'Inbound deleted' : (r?.msg || 'Failed'), r?.success !== false ? 'info' : 'error');
        document.getElementById('del-inbound-row').style.display = 'none';
        loadAdminData();
    });
} catch(e) {}

// --- Drag Sliders ---
try {
    const wireDragSlider = ({ trackId, handleId, fillId, inputId, valId, max, step=1 }) => {
        const track = document.getElementById(trackId), handle = document.getElementById(handleId);
        const fill = document.getElementById(fillId), input = document.getElementById(inputId), outVal = document.getElementById(valId);
        if (!track || !handle || !fill || !input || !outVal) return;
        const setFromValue = (v) => {
            const clamped = Math.max(0, Math.min(max, Math.round(Number(v)/step)*step));
            input.value = String(clamped); outVal.textContent = String(clamped);
            const pct = (clamped / max) * 100;
            fill.style.width = `${pct}%`; handle.style.left = `${pct}%`;
        };
        input.addEventListener('input', () => setFromValue(input.value));
        setFromValue(input.value || 0);
        const pxToVal = (x) => { const r = track.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / r.width)) * max; };
        track.addEventListener('pointerdown', (e) => setFromValue(pxToVal(e.clientX)));
        if (typeof gsap !== 'undefined' && typeof Draggable !== 'undefined') {
            gsap.registerPlugin(Draggable);
            Draggable.create(handle, { type: 'x', bounds: track, onDrag: function() { const r = track.getBoundingClientRect(); setFromValue(pxToVal(r.left + this.x + handle.offsetWidth/2)); }, onPress: function() { handle.style.cursor='grabbing'; }, onRelease: function() { handle.style.cursor='grab'; } });
        } else {
            let dragging = false;
            handle.addEventListener('pointerdown', (e) => { dragging=true; handle.setPointerCapture?.(e.pointerId); handle.style.cursor='grabbing'; });
            window.addEventListener('pointermove', (e) => { if(dragging) setFromValue(pxToVal(e.clientX)); });
            window.addEventListener('pointerup', () => { dragging=false; handle.style.cursor='grab'; });
        }
    };
    wireDragSlider({ trackId:'limit-track', handleId:'limit-handle', fillId:'limit-fill', inputId:'addc-limit', valId:'limit-val', max:500, step:1 });
    wireDragSlider({ trackId:'days-track', handleId:'days-handle', fillId:'days-fill', inputId:'addc-days', valId:'days-val', max:365, step:1 });
} catch(e) {}

try { document.getElementById('btn-add-client')?.addEventListener('click', addClient); } catch(e) {}
try { document.getElementById('btn-add-client-refresh')?.addEventListener('click', loadAdminData); } catch(e) {}

// --- Show Result UI (inbound/client tools) ---
const showResultUI = (title, obj) => {
    const uiCard = document.getElementById('ui-result');
    const uiBody = document.getElementById('ui-result-body');
    const raw = document.getElementById('addc-result');
    if (uiCard) uiCard.style.display = 'block';
    if (uiBody) uiBody.innerHTML = '';
    if (raw) raw.value = JSON.stringify(obj, null, 2);

    const addTitle = (t) => { const h=document.createElement('div'); h.style.fontWeight='800'; h.textContent=t; uiBody.appendChild(h); };
    const addChips = (arr) => { const w=document.createElement('div'); w.className='chips'; (arr||[]).forEach(x=>{ const c=document.createElement('div'); c.className='chip'; c.textContent=String(x); w.appendChild(c); }); uiBody.appendChild(w); };
    const addKV = (k,v) => { const row=document.createElement('div'); row.className='kv'; row.innerHTML=`<div class="k">${k}</div><div class="v">${v}</div>`; uiBody.appendChild(row); };

    addTitle(title);
    if (obj && obj.success === false) { addKV('Status','Failed'); addKV('Message', obj.msg || obj.error || '-'); return; }
    if (obj && Array.isArray(obj.obj)) { addKV('Count', obj.obj.length); addChips(obj.obj); return; }
    if (obj && Array.isArray(obj.obj?.data)) { addKV('Count', obj.obj.data.length); addChips(obj.obj.data.map(x=>`${x.email}: ${x.lastOnline}`)); return; }
    addKV('Status','OK'); addKV('Info','See raw JSON below');
};

// --- Inbound Tools ---
try {
    const getInboundId = () => Number(document.getElementById('addc-inbound')?.value);
    const getEmail = () => (document.getElementById('tool-email')?.value || '').trim();

    document.getElementById('btn-inb-onlines')?.addEventListener('click', async () => { const r = await callXui('inbounds/onlines', 'POST', {}); showResultUI('Online users', r); });
    document.getElementById('btn-inb-lastonline')?.addEventListener('click', async () => { const r = await callXui('inbounds/lastOnline', 'POST', {}); showResultUI('Last online', r); });
    document.getElementById('btn-inb-reset')?.addEventListener('click', async () => {
        const id = getInboundId(); if (!id) return;
        if (!confirm(`Reset ALL client traffic for inbound ${id}?`)) return;
        const r = await callXui(`inbounds/resetAllClientTraffics/${id}`, 'POST', {}); showResultUI(`Reset inbound ${id}`, r); loadAdminData();
    });
    document.getElementById('btn-all-reset')?.addEventListener('click', async () => {
        if (!confirm('Reset ALL traffics for ALL inbounds?')) return;
        const r = await callXui('inbounds/resetAllTraffics', 'POST', {}); showResultUI('Reset ALL traffics', r); loadAdminData();
    });

    // Auto-refresh onlines
    document.getElementById('auto-refresh-onlines')?.addEventListener('change', (e) => {
        clearInterval(__autoRefreshOntimer); __autoRefreshOntimer = null;
        if (e.target.checked) {
            __autoRefreshOntimer = setInterval(async () => {
                const r = await callXui('inbounds/onlines', 'POST', {});
                showResultUI('Online users (auto)', r);
            }, 30000);
            showToast('Auto-refresh onlines enabled (every 30s)');
        } else { showToast('Auto-refresh onlines disabled'); }
    });

    // Client tools
    document.getElementById('btn-client-reset')?.addEventListener('click', async () => {
        const inboundId = getInboundId(), email = getEmail();
        if (!inboundId || !email) { showToast('Select inbound + enter email', 'error'); return; }
        if (!confirm(`Reset traffic for ${email}?`)) return;
        const r = await callXui(`inbounds/${inboundId}/resetClientTraffic/${encodeURIComponent(email)}`, 'POST', {}); showResultUI(`Reset traffic: ${email}`, r); loadAdminData();
    });

    document.getElementById('btn-client-del')?.addEventListener('click', async () => {
        const inboundId = getInboundId(), email = getEmail();
        if (!inboundId || !email) { showToast('Select inbound + enter email', 'error'); return; }
        if (!confirm(`DELETE client ${email}?`)) return;
        const r = await callXui(`inbounds/${inboundId}/delClientByEmail/${encodeURIComponent(email)}`, 'POST', {}); showResultUI(`Delete client: ${email}`, r); loadAdminData();
    });

    document.getElementById('btn-client-ips')?.addEventListener('click', async () => {
        const email = getEmail(); if (!email) { showToast('Enter email', 'error'); return; }
        const r = await callXui(`inbounds/clientIps/${encodeURIComponent(email)}`, 'POST', {}); showResultUI(`Client IPs: ${email}`, r);
    });

    document.getElementById('btn-client-ips-clear')?.addEventListener('click', async () => {
        const email = getEmail(); if (!email) { showToast('Enter email', 'error'); return; }
        if (!confirm(`Clear IPs for ${email}?`)) return;
        const r = await callXui(`inbounds/clearClientIps/${encodeURIComponent(email)}`, 'POST', {}); showResultUI(`Clear IPs: ${email}`, r);
    });

    document.getElementById('btn-client-traffic-history')?.addEventListener('click', async () => {
        const email = getEmail(); if (!email) { showToast('Enter email', 'error'); return; }
        try {
            const r = await callXui(`inbounds/getClientTrafficsByEmail/${encodeURIComponent(email)}`, 'GET');
            if (r && r.success !== false) showResultUI(`Traffic history: ${email}`, r);
            else showResultUI(`Traffic history: ${email}`, r);
        } catch(e) { showToast('Traffic history not available on this panel version', 'error'); }
    });

    document.getElementById('btn-client-toggle-enable')?.addEventListener('click', async () => {
        const inboundId = getInboundId(), email = getEmail();
        if (!inboundId || !email) { showToast('Select inbound + enter email', 'error'); return; }
        const fullConf = getClientFullConfig(inboundId, email);
        if (!fullConf) { showToast('Client not found in cache — refresh data first', 'error'); return; }
        const r = await callXui(`inbounds/updateClient/${fullConf.id}`, 'POST', { id: inboundId, settings: { clients: [{ ...fullConf, enable: !fullConf.enable }] } });
        showResultUI(`Toggle enable: ${email}`, r);
        showToast(r?.success !== false ? `Client ${!fullConf.enable ? 'enabled' : 'disabled'}` : (r?.msg || 'Failed'), r?.success !== false ? 'info' : 'error');
        loadAdminData();
    });

} catch(e) {}

// --- DOMContentLoaded Setup ---
document.addEventListener("DOMContentLoaded", async () => {
    try {
        const p = new URLSearchParams(window.location.search);
        if (p.get('admin') === '1') {
            window.history.replaceState({}, document.title, window.location.pathname);
            currentRole = 'admin'; adminToken = 'zero-trust-secured';
            sessionStorage.setItem('xui_admin_token', 'zero-trust-secured');
            startAdminApp();
        }
    } catch(e) {}

    try {
        const urlParams = new URLSearchParams(window.location.search);
        const lastTab = localStorage.getItem('xui_last_tab') || 'client';
        const cachedClient = localStorage.getItem('xui_client_id') || '';
        const directClient = (urlParams.get('client') || urlParams.get('id') || '').trim();
        const directAuto = urlParams.get('auto') === '1' || urlParams.get('auto') === 'true';

        if (directClient) { document.getElementById('login-email').value = directClient; try { localStorage.setItem('xui_client_id', directClient); localStorage.setItem('xui_last_tab', 'client'); } catch(e) {} }
        else if (cachedClient) { document.getElementById('login-email').value = cachedClient; }

        if (directClient || directAuto) document.getElementById('tab-login-client').click();
        else if (lastTab === 'admin') document.getElementById('tab-login-admin').click();
        else document.getElementById('tab-login-client').click();

        const tok = sessionStorage.getItem('xui_admin_token');
        if (tok) {
            const headers = (tok === 'zero-trust-secured') ? {} : { Authorization: `Bearer ${tok}` };
            fetch('/api/status', { headers }).then(r => r.json()).then(j => {
                if (j && j.success) { currentRole = 'admin'; adminToken = tok; startAdminApp(); }
                else sessionStorage.removeItem('xui_admin_token');
            }).catch(() => { sessionStorage.removeItem('xui_admin_token'); });
        } else if ((lastTab === 'client' && cachedClient) || directAuto) {
            const idToCheck = (directClient || cachedClient || '').trim();
            if (idToCheck) {
                fetch('/public/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client', id: idToCheck }) })
                .then(r => r.json()).then(d => {
                    if (d && d.success) { currentRole = 'client'; startClientApp(d.clientData); }
                    else if (directAuto) showToast((d && d.msg) || 'User not found', 'error');
                }).catch(()=>{ if (directAuto) showToast('Connection Error', 'error'); });
            }
        }
    } catch(e) {}

    document.querySelector('.desktop-nav').style.display = 'none';
    document.querySelector('.mobile-nav').style.display = 'none';
    document.getElementById('main-fab').style.display = 'none';

    try {
        const res = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'admin', username: '', password: '' }) });
        const data = await res.json();
        if (data.success && data.msg === 'Cloudflare Zero Trust Authenticated') {
            currentRole = 'admin'; adminToken = 'zero-trust-secured'; startAdminApp();
        }
    } catch(e) {}
});
