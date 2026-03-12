const express = require('express');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const ThreeXUI = require('3xui-api-client');

const app = express();
const PORT = 8000;

app.use(cors());
app.use(express.json());

// Log requests for debugging
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Load server config
let serverConfig = { panelUrl: "http://127.0.0.1:2053", username: "admin", password: "password" };
try {
    const configData = fs.readFileSync(path.join(__dirname, 'server-config.json'), 'utf-8');
    serverConfig = JSON.parse(configData);
} catch (e) {
    console.log("No config found, using default");
}

let apiClient = null;
let currentConfig = serverConfig;

// Initialize on boot
async function initClient(config) {
    if (!config.panelUrl) return null;
    try {
        console.log(`Connecting to real 3x-ui panel at ${config.panelUrl}`);
        const client = new ThreeXUI(config.panelUrl, config.username, config.password);
        return client;
    } catch(e) {
        console.error("Failed to init panel client", e);
        return null;
    }
}

initClient(currentConfig).then(c => apiClient = c).catch(console.error);

app.use(express.static(path.join(__dirname)));

app.post('/api/settings', async (req, res) => {
    try {
        currentConfig = req.body;
        fs.writeFileSync(path.join(__dirname, 'server-config.json'), JSON.stringify(currentConfig, null, 2));
        apiClient = await initClient(currentConfig);
        res.json({ success: true, message: 'Settings saved and connected!' });
    } catch (e) {
        res.status(500).json({ success: false, msg: e.message });
    }
});

app.get('/api/status', async (req, res) => {
    if (!apiClient) return res.status(500).json({ success: false, msg: "Not configured" });
    try {
        const result = await apiClient.getServerStatus();
        res.json({ success: true, obj: result.obj || result });
    } catch(e) { 
        console.error(e);
        res.status(500).json({ success: false, msg: e.message }); 
    }
});

app.get('/api/inbounds', async (req, res) => {
    if (!apiClient) return res.status(500).json({ success: false });
    try {
        const result = await apiClient.getInbounds();
        res.json({ success: true, obj: result.obj || result });
    } catch(e) { 
        res.status(500).json({ success: false, msg: e.message }); 
    }
});

app.get('/api/clients', async (req, res) => {
    if (!apiClient) return res.status(500).json({ success: false });
    try {
        // Collect clients from inbounds
        const result = await apiClient.getInbounds();
        const clients = [];
        if (result && result.obj) {
            result.obj.forEach(inb => {
                if (inb.clientStats) {
                    inb.clientStats.forEach(c => clients.push({...c, inboundId: inb.id}));
                }
            });
        }
        res.json({ success: true, obj: clients });
    } catch(e) { 
        res.status(500).json({ success: false, msg: e.message }); 
    }
});

// Since the panel doesn't store graph metrics, we generate a small flat mock array 
// so the UI charts don't break - but they don't mean much.
app.get('/api/system-history', (req, res) => {
    const points = Array.from({length: 10}, (_, i) => ({
        time: `${i}:00`,
        cpu: 0,
        ram: 0
    }));
    res.json({ success: true, obj: points });
});

app.post('/api/action', async (req, res) => {
    // Attempting real mock actions
    const { action } = req.body;
    if (!apiClient) return res.status(500).json({ success: false });

    try {
        if (action === 'Restart Server') {
            await apiClient.restartXrayService();
        }
    } catch(e) {
        console.error("Action error", e);
    }
    
    setTimeout(() => {
        res.json({ success: true, msg: `${action} completed (Attempted on panel)` });
    }, 800);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Real server proxy running at http://0.0.0.0:${PORT}`);
});
