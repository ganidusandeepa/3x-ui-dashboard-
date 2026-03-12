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

document.getElementById('btn-login-admin').addEventListener('click', async () => {
    const un = document.getElementById('login-username').value;
    const pw = document.getElementById('login-password').value;
    const btn = document.getElementById('btn-login-admin');
    btn.textContent = "Authenticating...";
    try {
        const res = await fetch('/api/auth', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'admin', username: un, password: pw })
        });
        const data = await res.json();
        if(data.success) {
            currentRole = 'admin';
            adminToken = pw; // simplistic token
            await startAdminApp();
        } else {
            showToast("Invalid Admin Login", "error");
        }
    } catch(e) { showToast("Connection Error", "error"); }
    btn.textContent = "Login as Admin";
});

document.getElementById('btn-login-client').addEventListener('click', async () => {
    const id = document.getElementById('login-email').value;
    const btn = document.getElementById('btn-login-client');
    btn.textContent = "Checking...";
    try {
        const res = await fetch('/api/auth', {
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
    return { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
}

window.triggerAction = (action) => {
    showToast(`${action}...`);
    setTimeout(() => { showToast(`${action} Triggered`); loadAdminData(); }, 1000);
};

function closeModal() { document.getElementById('modal-overlay').classList.remove('active'); }
document.getElementById('main-fab').addEventListener('click', () => { document.getElementById('modal-overlay').classList.add('active'); });

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
            const down = toGB(s.netIO.down); const up = toGB(s.netIO.up);
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
            donutChart.data.datasets[0].data = [down, up]; donutChart.update();
        }

        if (inb.success) {
            const container = document.getElementById('inbound-cards-container');
            container.innerHTML = '';
            inb.obj.forEach(node => {
                container.innerHTML += `
                    <div class="card item-card">
                        <div class="item-header">
                            <div><strong style="font-size:1.1rem">${node.remark}</strong><p class="subtitle" style="margin:0">${node.protocol.toUpperCase()} • Port ${node.port}</p></div>
                            <div class="status-badge ${node.enable ? 'active' : ''}">${node.enable ? 'Online' : 'Off'}</div>
                        </div>
                        <div class="item-stats">
                            <div class="stat-box"><span class="label">DOWN</span><span class="val">${toGB(node.down)} GB</span></div>
                            <div class="stat-box"><span class="label">UP</span><span class="val">${toGB(node.up)} GB</span></div>
                            <div class="stat-box"><span class="label">USERS</span><span class="val">${node.clientStats.length}</span></div>
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
document.getElementById("btn-save-settings").addEventListener("click", async () => {
    const btn = document.getElementById("btn-save-settings");
    btn.textContent = "Connecting...";
    try {
        const payload = {
            panelUrl: document.getElementById("setting-url").value,
            username: document.getElementById("setting-user").value,
            password: document.getElementById("setting-pass").value
        };
        const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await res.json();
        if(data.success) {
            btn.textContent = "Test Successful!";
            showToast(data.msg || "Successfully connected to panel!");
            loadAdminData();
        } else {
            btn.textContent = "Test Failed";
            showToast(data.msg || "Failed to connect", "error");
        }
    } catch(e) {
        btn.textContent = "Error";
        showToast("Error testing settings", "error");
    }
    
    setTimeout(() => { btn.textContent = "Connect Real Panel"; }, 4000);
});

// Setup Initial State
document.addEventListener("DOMContentLoaded", async () => {
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
