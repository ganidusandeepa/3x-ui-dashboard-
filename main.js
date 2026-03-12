// --- 3D Background Setup ---
try {
    const canvasContainer = document.getElementById('canvas-container');
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 30;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    canvasContainer.appendChild(renderer.domElement);

    const particlesGeometry = new THREE.BufferGeometry();
    const posArray = new Float32Array(1000 * 3);
    for(let i = 0; i < 1000 * 3; i++) posArray[i] = (Math.random() - 0.5) * 100;
    particlesGeometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));

    const particlesMaterial = new THREE.PointsMaterial({
        size: 0.1, color: 0x00ffcc, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending
    });
    const particlesMesh = new THREE.Points(particlesGeometry, particlesMaterial);
    scene.add(particlesMesh);

    let mouseX = 0, mouseY = 0;
    document.addEventListener('mousemove', (e) => {
        mouseX = (e.clientX - window.innerWidth / 2) * 0.005;
        mouseY = (e.clientY - window.innerHeight / 2) * 0.005;
    });

    function animate() {
        requestAnimationFrame(animate);
        particlesMesh.rotation.y += 0.001 + mouseX * 0.01;
        particlesMesh.rotation.x += 0.001 + mouseY * 0.01;
        renderer.render(scene, camera);
    }
    animate();
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
} catch(e) { console.warn("WebGL BG Init Failed"); }

// --- Global Utils ---
const toGB = (bytes) => {
    const n = typeof bytes === 'string' ? Number(bytes) : Number(bytes ?? 0);
    const safe = Number.isFinite(n) ? n : 0;
    return (safe / (1024 ** 3)).toFixed(2);
};
let currentRole = null;
let adminToken = null;
let loopInterval = null;

function doLogout() {
    try { clearInterval(loopInterval); } catch(e) {}
    loopInterval = null;
    currentRole = null;
    adminToken = null;
    try { sessionStorage.removeItem('xui_admin_token'); } catch(e) {}

    // Reset UI
    document.getElementById('login-overlay').style.display = 'flex';
    document.querySelector('.desktop-nav').style.display = 'none';
    document.querySelector('.mobile-nav').style.display = 'none';
    document.getElementById('main-fab').style.display = 'none';

    // restore default tab (client) UI
    try { document.getElementById('tab-login-client').click(); } catch(e) {}
}

// Logout button (header)
document.addEventListener('click', (e) => {
    if (e.target && (e.target.id === 'btn-logout' || e.target.closest('#btn-logout'))) {
        doLogout();
    }
});

function showToast(msg, type="info") {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.style.borderColor = type === 'error' ? 'var(--red)' : 'var(--accent)';
    toast.innerHTML = `<i class="fa-solid fa-bell"></i> <span>${msg}</span>`;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000);
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
    const id = document.getElementById('login-email').value;
    const btn = document.getElementById('btn-login-client');
    btn.textContent = "Checking...";

    // cache last client id + last tab
    try {
        localStorage.setItem('xui_last_tab', 'client');
        localStorage.setItem('xui_client_id', id || '');
    } catch(e) {}

    try {
        const res = await fetch('/public/auth', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'client', id })
        });
        const data = await res.json();
        if(data.success) {
            currentRole = 'client';
            startClientApp(data.clientData);
        } else {
            showToast(data.msg || "User not found", "error");
        }
    } catch(e) { showToast("Connection Error", "error"); }
    btn.textContent = "Check Traffic";
});


// Activate specific Dashboard
async function startAdminApp() {
    document.getElementById('login-overlay').style.display = 'none';
    // show logout
    try { document.getElementById('btn-logout').style.display = 'inline-flex'; } catch(e) {}
    document.getElementById('tab-user-view').style.display = 'none';

    document.querySelector('.desktop-nav').style.display = 'flex';
    document.querySelector('.mobile-nav').style.display = 'flex';
    document.getElementById('main-fab').style.display = 'flex';
    
    switchTab('overview');
    initAdminCharts();
    await loadAdminData();
    loopInterval = setInterval(loadAdminData, 10000);
    // load settings
    fetch('/api/settings').then(r=>r.json()).then(set=>{
        if(set && set.panelUrl) {
            document.getElementById("setting-url").value = set.panelUrl;
            document.getElementById("setting-user").value = set.username || "";
            document.getElementById("setting-pass").value = set.password || "";
        }
    }).catch(()=>{});
}

function startClientApp(client) {
    document.getElementById('login-overlay').style.display = 'none';
    // show logout
    try { document.getElementById('btn-logout').style.display = 'inline-flex'; } catch(e) {}
    // Hide Admin Navigation completely
    document.querySelector('.desktop-nav').style.visibility = 'hidden';
    document.querySelector('.mobile-nav').style.display = 'none';
    document.getElementById('main-fab').style.display = 'none';
    document.querySelector('.user-status').innerHTML = '<span>Hi, <strong style="color:var(--accent)">'+client.email+'</strong></span>';
    
    // Hide all tabs except user view
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.getElementById('tab-user-view').classList.add('active');

    const down = parseFloat(toGB(client.down));
    const up = parseFloat(toGB(client.up));
    const totalUsed = (down + up).toFixed(2);
    const limit = parseFloat(toGB(client.total));
    const remainDesc = limit === 0 ? "Unlimited GB" : `${limit.toFixed(2)} GB`;

    // Extra details
    const fmtTime = (ms) => {
        const n = Number(ms);
        if (!Number.isFinite(n) || n <= 0) return '-';
        return new Date(n).toLocaleString();
    };

    // keep links for buttons
    let currentSubLink = client.subLink || null;
    let currentVlessLink = client.vlessLink || null;

    try {
        document.getElementById('user-email').textContent = client.email || '-';
        document.getElementById('user-uuid').textContent = client.uuid || '-';
        document.getElementById('user-subid').textContent = client.subId || '-';
        document.getElementById('user-last-online').textContent = fmtTime(client.lastOnline);
        const onlineTxt = client.isOnline === true ? 'Online' : (client.isOnline === false ? 'Offline' : '-');
        document.getElementById('user-online').textContent = onlineTxt;
        const ips = Array.isArray(client.ips) ? client.ips.join(', ') : (client.ips || '-');
        document.getElementById('user-ips').textContent = ips || '-';
    } catch(e) {}

    // Buttons: copy + QR
    const copyText = async (text) => {
        if (!text) return false;
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (e) {
            // fallback
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
                return true;
            } catch (e2) {
                return false;
            }
        }
    };

    try {
        document.getElementById('btn-copy-sub')?.addEventListener('click', async () => {
            const ok = await copyText(currentSubLink);
            showToast(ok ? 'Subscription link copied' : 'No subscription link available', ok ? 'info' : 'error');
        }, { once: true });

        document.getElementById('btn-copy-vless')?.addEventListener('click', async () => {
            const ok = await copyText(currentVlessLink);
            showToast(ok ? 'VLESS link copied' : 'No VLESS link available', ok ? 'info' : 'error');
        }, { once: true });

        const qrModal = document.getElementById('qr-modal');
        const qrBox = document.getElementById('qr-box');
        const closeBtn = document.getElementById('btn-close-qr');

        document.getElementById('btn-show-qr')?.addEventListener('click', () => {
            if (!currentVlessLink) { showToast('No VLESS link available', 'error'); return; }
            qrBox.innerHTML = '';
            // eslint-disable-next-line no-undef
            new QRCode(qrBox, { text: currentVlessLink, width: 240, height: 240, correctLevel: QRCode.CorrectLevel.M });
            qrModal.style.display = 'flex';
        }, { once: true });

        closeBtn?.addEventListener('click', () => { qrModal.style.display = 'none'; }, { once: true });
        qrModal?.addEventListener('click', (e) => { if (e.target === qrModal) qrModal.style.display = 'none'; }, { once: true });

    } catch(e) {}

    gsap.to('#user-used', { innerHTML: totalUsed, duration: 1.5, snap: { innerHTML: 0.01 } });
    gsap.to('#user-dl', { innerHTML: down, duration: 1, snap: { innerHTML: 0.01 } });
    gsap.to('#user-up', { innerHTML: up, duration: 1, snap: { innerHTML: 0.01 } });
    document.getElementById('user-total').innerText = remainDesc;
    
    if(!client.enable) {
        document.getElementById('user-status-text').innerText = "Disabled or Expired";
        document.getElementById('user-status-text').classList.remove('active');
        document.getElementById('user-status-text').style.color = "var(--red)";
    }

    // Progress
    if(limit > 0) {
        let pct = (totalUsed / limit) * 100;
        if(pct > 100) pct = 100;
        document.getElementById('user-progress').style.width = `${pct}%`;
    } else {
        document.getElementById('user-progress').style.width = `100%`;
    }

    // User Donut
    const donutCtx = document.getElementById('userDonut').getContext('2d');
    new Chart(donutCtx, {
        type: 'doughnut',
        data: { datasets: [{ data: [down, up], backgroundColor: ['#0066ff', '#00ffcc'], borderWidth: 0 }] },
        options: { cutout: '80%', plugins: { tooltip: { enabled: false } } }
    });
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
document.getElementById('main-fab').addEventListener('click', () => { document.getElementById('modal-overlay').classList.add('active'); });

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

function switchTab(tabId) {
    document.querySelectorAll('.nav-btn, .m-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.toggle('active', t.id === `tab-${tabId}`));
}
document.querySelectorAll('.nav-btn, .m-nav-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));


// --- Admins Charts Setup ---
let trafficChart, donutChart, cpuChart, ramChart;
function initAdminCharts() {
    const trafficCtx = document.getElementById('trafficChart').getContext('2d');
    trafficChart = new Chart(trafficCtx, {
        type: 'line', data: { labels: ['M','T','W','T','F','S','S'], datasets: [
            { label: 'Down', data: [5,8,4,7,9,12,10], borderColor: '#0066ff', tension: 0.4, fill: true, backgroundColor: 'rgba(0,102,255,0.05)' },
            { label: 'Up', data: [2,3,2,4,3,5,4], borderColor: '#00ffcc', tension: 0.4, fill: true, backgroundColor: 'rgba(0,255,204,0.05)' }
        ]}, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { x: { display: false }, y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#555' } } } }
    });

    const donutCtx = document.getElementById('usageDonut').getContext('2d');
    donutChart = new Chart(donutCtx, { type: 'doughnut', data: { datasets: [{ data: [70, 30], backgroundColor: ['#0066ff', '#00ffcc'], borderWidth: 0 }] }, options: { cutout: '80%', plugins: { tooltip: { enabled: false } } }});

    const cpuCtx = document.getElementById('cpuChart').getContext('2d');
    cpuChart = new Chart(cpuCtx, { type: 'line', data: { labels: Array(10).fill(''), datasets: [{ data: [10,15,12,20,18,25,22,30,28,35], borderColor: '#00ffcc', borderWidth: 2, pointRadius: 0, tension: 0.4 }]}, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }});

    const ramCtx = document.getElementById('ramChart').getContext('2d');
    ramChart = new Chart(ramCtx, { type: 'line', data: { labels: Array(10).fill(''), datasets: [{ data: [40,42,41,45,44,48,46,50,49,52], borderColor: '#0066ff', borderWidth: 2, pointRadius: 0, tension: 0.4 }]}, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }});
}

// --- Admin Data Injection ---
async function loadAdminData() {
    try {
        const [stat, inb, cli, sys] = await Promise.all([
            fetch('/api/status', {headers: getAdminHeaders()}).then(r => r.json()),
            fetch('/api/inbounds', {headers: getAdminHeaders()}).then(r => r.json()),
            fetch('/api/clients', {headers: getAdminHeaders()}).then(r => r.json()),
            fetch('/api/system-history', {headers: getAdminHeaders()}).then(r => r.json())
        ]);

        if (stat.success) {
            const s = stat.obj;
            // Prefer all-time traffic counters if available; netIO is often instantaneous IO and can be tiny.
            const down = toGB((s.netTraffic && (s.netTraffic.down ?? s.netTraffic.recv)) ?? s.netIO?.down);
            const up = toGB((s.netTraffic && (s.netTraffic.up ?? s.netTraffic.sent)) ?? s.netIO?.up);
            const total = (parseFloat(down) + parseFloat(up)).toFixed(2);
            gsap.to('#total-traffic', { innerHTML: total, duration: 1.5, snap: { innerHTML: 0.01 } });
            gsap.to('#dl-traffic', { innerHTML: down, duration: 1.5, snap: { innerHTML: 0.01 } });
            gsap.to('#up-traffic', { innerHTML: up, duration: 1.5, snap: { innerHTML: 0.01 } });
            const cpuNum = Number(s.cpu);
            const cpuPct = Number.isFinite(cpuNum) ? Math.max(0, Math.min(100, cpuNum)) : 0;
            document.getElementById('cpu-percent').textContent = `${cpuPct.toFixed(1)}%`;

            const memCur = Number(s.mem?.current);
            const memTot = Number(s.mem?.total);
            const ramPct = (Number.isFinite(memCur) && Number.isFinite(memTot) && memTot > 0)
                ? Math.max(0, Math.min(100, (memCur / memTot) * 100))
                : 0;
            document.getElementById('ram-percent').textContent = `${ramPct.toFixed(1)}%`;

            // IP info (from server status)
            try {
                document.getElementById('node-ip').textContent = s.publicIP?.ipv4 || s.publicIP?.ipv6 || '-';
                document.getElementById('node-region').textContent = s.publicIP?.country || '-';
                document.getElementById('node-ping').textContent = '-';
                document.getElementById('xray-version').textContent = s.xray?.version || '-';
            } catch(e) {}

            donutChart.data.datasets[0].data = [down, up]; donutChart.update();
        }

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
                    <div class="card item-card">
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
        }

        if (cli.success) {
            const container = document.getElementById('client-list');
            container.innerHTML = '';
            cli.obj.forEach(user => {
                container.innerHTML += `
                    <div class="card item-card" style="margin-bottom:10px">
                        <div class="item-header" style="margin:0">
                            <div style="display:flex; align-items:center; gap:12px">
                                <i class="fa-solid fa-circle-user" style="font-size:1.5rem; color:var(--blue)"></i>
                                <div><strong>${user.email}</strong><p class="subtitle" style="margin:0">Limit: ${user.total > 0 ? toGB(user.total)+' GB' : 'Unlim'}</p></div>
                            </div>
                            <div class="stat-box" style="text-align:right"><span class="label">USED</span><span class="val" style="color:var(--accent)">${toGB(user.up + user.down)} GB</span></div>
                        </div>
                    </div>`;
            });
        }

        if (sys.success) {
            cpuChart.data.datasets[0].data = sys.obj.map(p => p.cpu);
            ramChart.data.datasets[0].data = sys.obj.map(p => p.ram);
            cpuChart.update(); ramChart.update();
        }

    } catch(e) { console.error("Data Load Error"); }
}

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
        const r = await callXui('server/getNewUUID', 'GET');
        setServerOutput(r);
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

async function addClientVless() {
    const out = document.getElementById('addc-result');
    const inboundId = Number(document.getElementById('addc-inbound')?.value);
    const email = document.getElementById('addc-email')?.value?.trim();
    const limitGb = Number(document.getElementById('addc-limit')?.value || 0);
    const days = Number(document.getElementById('addc-days')?.value || 0);

    if (!email) { showToast('Enter client email/ID', 'error'); return; }
    if (!inboundId) { showToast('Select inbound', 'error'); return; }

    out.value = 'Creating client...';

    // get uuid
    const uuidRes = await callXui('server/getNewUUID', 'GET');
    const uuid = (uuidRes && (uuidRes.obj || uuidRes.uuid || uuidRes.data)) ? (uuidRes.obj || uuidRes.uuid || uuidRes.data) : (typeof uuidRes === 'string' ? uuidRes : null);
    const clientId = (typeof uuid === 'string') ? uuid.trim() : null;

    if (!clientId) {
        out.value = 'Failed to generate UUID';
        return;
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

    out.value = JSON.stringify({ api: res, vless: links.vlessLink, sub: links.subLink }, null, 2);
    showToast('Client created');

    // refresh view
    loadAdminData();
}

try {
    const out = () => document.getElementById('addc-result');
    const getInboundId = () => Number(document.getElementById('addc-inbound')?.value);
    const getEmail = () => (document.getElementById('tool-email')?.value || '').trim();

    document.getElementById('btn-add-client')?.addEventListener('click', addClientVless);
    document.getElementById('btn-add-client-refresh')?.addEventListener('click', loadAdminData);

    // Inbound tools
    document.getElementById('btn-inb-onlines')?.addEventListener('click', async () => {
        out().value = 'Loading onlines...';
        const r = await callXui('inbounds/onlines', 'POST', {});
        out().value = JSON.stringify(r, null, 2);
    });

    document.getElementById('btn-inb-lastonline')?.addEventListener('click', async () => {
        out().value = 'Loading last online...';
        const r = await callXui('inbounds/lastOnline', 'POST', {});
        out().value = JSON.stringify(r, null, 2);
    });

    document.getElementById('btn-inb-reset')?.addEventListener('click', async () => {
        const id = getInboundId();
        if (!id) return;
        if (!confirm(`Reset ALL client traffic for inbound ${id}?`)) return;
        out().value = 'Resetting inbound traffics...';
        const r = await callXui(`inbounds/resetAllClientTraffics/${id}`, 'POST', {});
        out().value = JSON.stringify(r, null, 2);
        loadAdminData();
    });

    document.getElementById('btn-all-reset')?.addEventListener('click', async () => {
        if (!confirm('Reset ALL traffics for ALL inbounds?')) return;
        out().value = 'Resetting ALL traffics...';
        const r = await callXui('inbounds/resetAllTraffics', 'POST', {});
        out().value = JSON.stringify(r, null, 2);
        loadAdminData();
    });

    // Client tools
    document.getElementById('btn-client-reset')?.addEventListener('click', async () => {
        const inboundId = getInboundId();
        const email = getEmail();
        if (!inboundId || !email) { showToast('Select inbound + enter email', 'error'); return; }
        if (!confirm(`Reset traffic for ${email} in inbound ${inboundId}?`)) return;
        out().value = 'Resetting client traffic...';
        const r = await callXui(`inbounds/${inboundId}/resetClientTraffic/${encodeURIComponent(email)}`, 'POST', {});
        out().value = JSON.stringify(r, null, 2);
        loadAdminData();
    });

    document.getElementById('btn-client-del')?.addEventListener('click', async () => {
        const inboundId = getInboundId();
        const email = getEmail();
        if (!inboundId || !email) { showToast('Select inbound + enter email', 'error'); return; }
        if (!confirm(`DELETE client ${email} from inbound ${inboundId}?`)) return;
        out().value = 'Deleting client...';
        const r = await callXui(`inbounds/${inboundId}/delClientByEmail/${encodeURIComponent(email)}`, 'POST', {});
        out().value = JSON.stringify(r, null, 2);
        loadAdminData();
    });

    document.getElementById('btn-client-ips')?.addEventListener('click', async () => {
        const email = getEmail();
        if (!email) { showToast('Enter email', 'error'); return; }
        out().value = 'Fetching client IPs...';
        const r = await callXui(`inbounds/clientIps/${encodeURIComponent(email)}`, 'POST', {});
        out().value = JSON.stringify(r, null, 2);
    });

    document.getElementById('btn-client-ips-clear')?.addEventListener('click', async () => {
        const email = getEmail();
        if (!email) { showToast('Enter email', 'error'); return; }
        if (!confirm(`Clear IPs for ${email}?`)) return;
        out().value = 'Clearing client IPs...';
        const r = await callXui(`inbounds/clearClientIps/${encodeURIComponent(email)}`, 'POST', {});
        out().value = JSON.stringify(r, null, 2);
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

    // Restore cached login inputs/tab
    try {
        const lastTab = localStorage.getItem('xui_last_tab') || 'client';
        const cachedClient = localStorage.getItem('xui_client_id') || '';
        if (cachedClient) document.getElementById('login-email').value = cachedClient;

        if (lastTab === 'admin') {
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
        } else if (lastTab === 'client' && cachedClient) {
            // auto run client check again
            fetch('/public/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'client', id: cachedClient })
            }).then(r => r.json()).then(d => {
                if (d && d.success) {
                    currentRole = 'client';
                    startClientApp(d.clientData);
                }
            }).catch(()=>{});
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
