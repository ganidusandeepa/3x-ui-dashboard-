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
const toGB = (bytes) => ((bytes || 0) / (1024 ** 3)).toFixed(2);

function showToast(msg) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<i class="fa-solid fa-bell"></i> <span>${msg}</span>`;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 2500);
}

window.triggerAction = (action) => {
    showToast(`${action}...`);
    setTimeout(() => { showToast(`${action} Done!`); loadAllData(); }, 1500);
};

function closeModal() {
    document.getElementById('modal-overlay').classList.remove('active');
}

document.getElementById('main-fab').addEventListener('click', () => {
    document.getElementById('modal-overlay').classList.add('active');
});

// --- Tab Switching Logic (Combined Desktop/Mobile) ---
function switchTab(tabId) {
    // Buttons
    document.querySelectorAll('.nav-btn, .m-nav-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tabId);
    });
    // Tabs
    document.querySelectorAll('.tab-content').forEach(t => {
        t.classList.toggle('active', t.id === `tab-${tabId}`);
    });
}

document.querySelectorAll('.nav-btn, .m-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// --- Charts Setup ---
let trafficChart, donutChart, cpuChart, ramChart;

function initCharts() {
    // 1. General Traffic Chart
    const trafficCtx = document.getElementById('trafficChart').getContext('2d');
    trafficChart = new Chart(trafficCtx, {
        type: 'line',
        data: { labels: ['M','T','W','T','F','S','S'], datasets: [
            { label: 'Down', data: [5,8,4,7,9,12,10], borderColor: '#0066ff', tension: 0.4, fill: true, backgroundColor: 'rgba(0,102,255,0.05)' },
            { label: 'Up', data: [2,3,2,4,3,5,4], borderColor: '#00ffcc', tension: 0.4, fill: true, backgroundColor: 'rgba(0,255,204,0.05)' }
        ]},
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { x: { display: false }, y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#555' } } } }
    });

    // 2. Usage Donut
    const donutCtx = document.getElementById('usageDonut').getContext('2d');
    donutChart = new Chart(donutCtx, {
        type: 'doughnut',
        data: { datasets: [{ data: [70, 30], backgroundColor: ['#0066ff', '#00ffcc'], borderWidth: 0 }] },
        options: { cutout: '80%', plugins: { tooltip: { enabled: false } } }
    });

    // 3. Mini CPU Chart
    const cpuCtx = document.getElementById('cpuChart').getContext('2d');
    cpuChart = new Chart(cpuCtx, {
        type: 'line',
        data: { labels: Array(10).fill(''), datasets: [{ data: [10,15,12,20,18,25,22,30,28,35], borderColor: '#00ffcc', borderWidth: 2, pointRadius: 0, tension: 0.4 }]},
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }
    });

    // 4. Mini RAM Chart
    const ramCtx = document.getElementById('ramChart').getContext('2d');
    ramChart = new Chart(ramCtx, {
        type: 'line',
        data: { labels: Array(10).fill(''), datasets: [{ data: [40,42,41,45,44,48,46,50,49,52], borderColor: '#0066ff', borderWidth: 2, pointRadius: 0, tension: 0.4 }]},
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }
    });
}

// --- Data Injection ---
async function loadAllData() {
    try {
        const [stat, inb, cli, sys] = await Promise.all([
            fetch('/api/status').then(r => r.json()),
            fetch('/api/inbounds').then(r => r.json()),
            fetch('/api/clients').then(r => r.json()),
            fetch('/api/system-history').then(r => r.json())
        ]);

        if (stat.success) {
            const s = stat.obj;
            const down = toGB(s.netIO.down);
            const up = toGB(s.netIO.up);
            const total = (parseFloat(down) + parseFloat(up)).toFixed(2);
            
            // GSAP Animations for Numbers
            gsap.to('#total-traffic', { innerHTML: total, duration: 1.5, snap: { innerHTML: 0.01 } });
            gsap.to('#dl-traffic', { innerHTML: down, duration: 1.5, snap: { innerHTML: 0.01 } });
            gsap.to('#up-traffic', { innerHTML: up, duration: 1.5, snap: { innerHTML: 0.01 } });
            
            document.getElementById('cpu-percent').textContent = `${s.cpu}%`;
            const ramPct = ((s.mem.current / s.mem.total) * 100).toFixed(1);
            document.getElementById('ram-percent').textContent = `${ramPct}%`;

            donutChart.data.datasets[0].data = [down, up];
            donutChart.update();
        }

        // Inbound Cards (Not table)
        if (inb.success) {
            const container = document.getElementById('inbound-cards-container');
            container.innerHTML = '';
            inb.obj.forEach(node => {
                const card = document.createElement('div');
                card.className = 'card item-card';
                card.innerHTML = `
                    <div class="item-header">
                        <div>
                            <strong style="font-size:1.1rem">${node.remark}</strong>
                            <p class="subtitle" style="margin:0">${node.protocol.toUpperCase()} • Port ${node.port}</p>
                        </div>
                        <div class="status-badge active">${node.enable ? 'Online' : 'Off'}</div>
                    </div>
                    <div class="item-stats">
                        <div class="stat-box"><span class="label">DOWN</span><span class="val">${toGB(node.down)} GB</span></div>
                        <div class="stat-box"><span class="label">UP</span><span class="val">${toGB(node.up)} GB</span></div>
                        <div class="stat-box"><span class="label">USERS</span><span class="val">${node.clientStats.length}</span></div>
                    </div>
                `;
                container.appendChild(card);
            });
        }

        // Client Cards
        if (cli.success) {
            const container = document.getElementById('client-list');
            container.innerHTML = '';
            cli.obj.forEach(user => {
                const item = document.createElement('div');
                item.className = 'card item-card';
                item.style.marginBottom = '10px';
                item.innerHTML = `
                    <div class="item-header" style="margin:0">
                        <div style="display:flex; align-items:center; gap:12px">
                            <i class="fa-solid fa-circle-user" style="font-size:1.5rem; color:var(--blue)"></i>
                            <div>
                                <strong>${user.email}</strong>
                                <p class="subtitle" style="margin:0">Total: ${toGB(user.total)} GB Limit</p>
                            </div>
                        </div>
                        <div class="stat-box" style="text-align:right">
                            <span class="label">USED</span>
                            <span class="val" style="color:var(--accent)">${toGB(user.up + user.down)} GB</span>
                        </div>
                    </div>
                `;
                container.appendChild(item);
            });
        }

        // Update System History Charts
        if (sys.success) {
            cpuChart.data.datasets[0].data = sys.obj.map(p => p.cpu);
            ramChart.data.datasets[0].data = sys.obj.map(p => p.ram);
            cpuChart.update();
            ramChart.update();
        }

    } catch(e) { console.error("Data Load Error", e); }
}

async function loadSettings() {
    try {
        const res = await fetch('/api/settings');
        const set = await res.json();
        if(set) {
            document.getElementById("setting-url").value = set.panelUrl || "";
            document.getElementById("setting-user").value = set.username || "";
            document.getElementById("setting-pass").value = set.password || "";
        }
    } catch(e) { console.error("Could not load settings"); }
}

document.getElementById("btn-save-settings").addEventListener("click", async () => {
    const btn = document.getElementById("btn-save-settings");
    btn.textContent = "Connecting...";
    
    const payload = {
        panelUrl: document.getElementById("setting-url").value,
        username: document.getElementById("setting-user").value,
        password: document.getElementById("setting-pass").value
    };
    
    try {
        const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        
        if(data.success) {
            btn.textContent = "Connected!";
            showToast("Successfully connected to panel!");
            loadAllData();
        } else {
            btn.textContent = "Failed";
            showToast("Failed to connect", "error");
        }
    } catch(e) {
        btn.textContent = "Error";
        showToast("Error saving settings", "error");
    }
    
    setTimeout(() => { btn.textContent = "Connect Real Panel"; }, 2000);
});

// Initial Boot
document.addEventListener("DOMContentLoaded", () => {
    initCharts();
    loadAllData();
    loadSettings();
    // Refresh loop every 10s
    setInterval(loadAllData, 10000);
});
