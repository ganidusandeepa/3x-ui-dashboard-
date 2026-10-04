process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const path = require('path');
const cors = require('cors');
const http = require('http');
const https = require('https');

const app = express();

// Built-in .env parser for secure secret management without committing credentials to Git
const fs = require('fs');
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  try {
    const lines = fs.readFileSync(envFile, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      }
    }
  } catch (e) {}
}

const PANEL_URL_RAW = (process.env.PANEL_URL || '').trim();
const PANEL_URL = PANEL_URL_RAW.replace(/\/$/, '');
const PANEL_API_TOKEN = (process.env.PANEL_API_TOKEN || process.env.PANEL_TOKEN || '').trim();
const ADMIN_USER = (process.env.PANEL_USERNAME || '').trim();
const ADMIN_PASS = (process.env.PANEL_PASSWORD || '').trim();
const ADMIN_LOGIN_ENABLED = process.env.ADMIN_LOGIN_ENABLED === 'true'; // OFF by default
const MASK_VPS_DETAILS = process.env.MASK_VPS_DETAILS !== 'false'; // ON by default
const PORT = Number(process.env.PORT || 8080);
const INTERVAL_MS = Math.max(1000, Number(process.env.METRICS_INTERVAL_MS || 3000));
const CACHE_TTL_S = Number(process.env.METRICS_CACHE_TTL || 3);

console.log('----------------------------------------------------');
console.log('3x-ui Dashboard Starting');
console.log('PANEL_URL Configured:', PANEL_URL ? 'YES' : 'NO (Required - set in .env or environment)');
console.log('API Token Configured:', PANEL_API_TOKEN ? 'YES' : 'NO');
console.log('Admin Login Active:', ADMIN_LOGIN_ENABLED ? 'ENABLED' : 'TEMPORARILY DISABLED');
console.log('VPS Privacy Masking:', MASK_VPS_DETAILS ? 'ACTIVE' : 'OFF');
console.log('Port:', PORT);
console.log('----------------------------------------------------');

// Robust HTTP/HTTPS fetch implementation with insecureHTTPParser: true
// This completely resolves HPE_INVALID_VERSION on Go/x-ui HTTP responses
function panelFetch(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      if (!PANEL_URL) {
        return reject(new Error('PANEL_URL is not configured in .env or environment'));
      }
      const url = new URL(urlStr.startsWith('http') ? urlStr : `${PANEL_URL}${urlStr.startsWith('/') ? '' : '/'}${urlStr}`);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      const method = (options.method || 'GET').toUpperCase();
      const headers = Object.assign({}, options.headers || {});

      let bodyData = options.body;
      if (bodyData && typeof bodyData === 'object' && !Buffer.isBuffer(bodyData)) {
        bodyData = JSON.stringify(bodyData);
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      }
      if (bodyData && !headers['Content-Length']) {
        headers['Content-Length'] = Buffer.byteLength(bodyData);
      }

      const reqOptions = {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: method,
        headers: headers,
        insecureHTTPParser: true, // Lenient parser to accept all HTTP responses without HPE_INVALID_VERSION
        rejectUnauthorized: false
      };

      const req = lib.request(reqOptions, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks);
          const bodyText = bodyBuffer.toString('utf8');

          resolve({
            status: res.statusCode || 200,
            statusCode: res.statusCode || 200,
            ok: (res.statusCode >= 200 && res.statusCode < 300),
            headers: {
              get: (name) => {
                const val = res.headers[name.toLowerCase()];
                return Array.isArray(val) ? val.join(', ') : (val || null);
              },
              raw: () => res.headers
            },
            text: async () => bodyText,
            json: async () => {
              if (!bodyText.trim()) throw new Error(`Empty response from panel (HTTP ${res.statusCode})`);
              return JSON.parse(bodyText);
            },
            arrayBuffer: async () => bodyBuffer.buffer.slice(bodyBuffer.byteOffset, bodyBuffer.byteOffset + bodyBuffer.byteLength)
          });
        });
      });

      req.on('error', (err) => {
        console.error(`[panelFetch Network Error] ${method} ${urlStr} -> ${err.message}`);
        reject(err);
      });

      if (bodyData) {
        req.write(bodyData);
      }
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

// Session cache (18 min) for cookie-based fallback
let _session = { cookie: null, ts: 0 };
const SESSION_TTL = 18 * 60 * 1000;

async function getSession(force = false) {
  const now = Date.now();
  if (!force && _session.cookie && now - _session.ts < SESSION_TTL) {
    return _session.cookie;
  }
  try {
    const loginRes = await panelFetch(`${PANEL_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
      redirect: 'follow'
    });
    const cookie = loginRes.headers.get('set-cookie');
    if (cookie) {
      _session = { cookie, ts: now };
      console.log('[Auth] Obtained panel session cookie successfully');
    }
    return cookie;
  } catch (err) {
    return null;
  }
}

// Unified auth headers for 3x-ui API (Bearer Token from Settings -> Security -> API Token)
async function getAuthHeaders() {
  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (compatible; 3x-ui-dashboard)',
    'Referer': `${PANEL_URL}/`
  };
  if (PANEL_API_TOKEN) {
    headers['Authorization'] = `Bearer ${PANEL_API_TOKEN}`;
  }
  if (_session.cookie) {
    headers['Cookie'] = _session.cookie;
  } else if (ADMIN_USER && ADMIN_PASS && !PANEL_API_TOKEN) {
    const cookie = await getSession();
    if (cookie) headers['Cookie'] = cookie;
  }
  return headers;
}

// Safe JSON parser with helpful logs
async function parseResponseJson(res, context = '') {
  const text = await res.text();
  console.log(`[Panel Response] ${context} -> HTTP ${res.status}, length: ${text.length}`);
  if (!text || !text.trim()) {
    throw new Error(`Panel returned empty body (HTTP ${res.status})`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    const snippet = text.slice(0, 150).replace(/\s+/g, ' ');
    throw new Error(`Panel returned non-JSON (HTTP ${res.status}): ${snippet}`);
  }
}

// Rolling CPU/RAM history buffer
let _sysHistory = [];
const HISTORY_MAX = 24;
function pushHistory(s) {
  try {
    const cpu = Number(s.cpu) || 0;
    const memCur = Number(s.mem?.current) || 0;
    const memTot = Number(s.mem?.total) || 1;
    const ram = memTot > 0 ? Math.round((memCur / memTot) * 100) : 0;
    _sysHistory.push({
      time: new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit' }),
      cpu: Math.round(Math.min(100, Math.max(0, cpu))),
      ram: Math.min(100, Math.max(0, ram))
    });
    if (_sysHistory.length > HISTORY_MAX) _sysHistory.shift();
  } catch (e) {}
}

const _cache = new Map();
async function cachedJson(key, ttlS, producer) {
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && now - hit.ts < ttlS * 1000) return hit.value;
  const value = await producer();
  _cache.set(key, { ts: now, value });
  return value;
}

// --- Persistent Monthly Client Traffic Tracker ---
// Tracks baseline usage per client to distinguish Lifetime Total from Monthly Period (1st - 30/31st)
const TRAFFIC_STORE_PATH = path.join(__dirname, 'traffic_history.json');
let _trafficRecords = {};

function loadTrafficRecords() {
  try {
    if (fs.existsSync(TRAFFIC_STORE_PATH)) {
      const raw = fs.readFileSync(TRAFFIC_STORE_PATH, 'utf8');
      _trafficRecords = JSON.parse(raw || '{}') || {};
    }
  } catch (err) {
    console.error('[Traffic Tracker] Failed to load records:', err.message);
    _trafficRecords = {};
  }
}

let _saveTimeout = null;
function scheduleSaveTrafficRecords() {
  if (_saveTimeout) return;
  _saveTimeout = setTimeout(() => {
    _saveTimeout = null;
    try {
      fs.writeFileSync(TRAFFIC_STORE_PATH, JSON.stringify(_trafficRecords, null, 2), 'utf8');
    } catch (err) {
      console.error('[Traffic Tracker] Failed to persist records:', err.message);
    }
  }, 1000);
}

loadTrafficRecords();

function getClientTrafficMetrics(email, rawUp, rawDown, limitBytes) {
  const up = Math.max(0, Number(rawUp) || 0);
  const down = Math.max(0, Number(rawDown) || 0);
  const rawTotal = up + down;

  if (!email) {
    return { lifetimeUsed: rawTotal, monthlyUsed: rawTotal, rawTotal, baselineRaw: 0 };
  }

  const normEmail = String(email).trim().toLowerCase();
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  let rec = _trafficRecords[normEmail];
  let dirty = false;

  if (!rec) {
    rec = {
      currentMonth,
      baselineRaw: rawTotal,
      lastRaw: rawTotal,
      archivedLifetime: 0,
      createdAt: now.getTime(),
      updatedAt: now.getTime()
    };
    _trafficRecords[normEmail] = rec;
    dirty = true;
  } else {
    // 1. Calendar month rollover check (1st of month at 00:00:00)
    if (rec.currentMonth !== currentMonth) {
      if (rawTotal >= (rec.lastRaw || 0)) {
        // 3x-ui did NOT auto-reset: baseline for the new month is the raw counter at rollover
        rec.baselineRaw = rawTotal;
      } else {
        // 3x-ui DID auto-reset on the 1st: archive previous months
        rec.archivedLifetime = (rec.archivedLifetime || 0) + (rec.lastRaw || 0);
        rec.baselineRaw = 0;
      }
      rec.currentMonth = currentMonth;
      rec.lastRaw = rawTotal;
      rec.updatedAt = now.getTime();
      dirty = true;
    } else {
      // 2. Mid-month check: if 3x-ui or admin manually reset traffic (counter dropped by > 2MB)
      if (rawTotal < (rec.lastRaw || 0) - 2097152) {
        rec.archivedLifetime = (rec.archivedLifetime || 0) + (rec.lastRaw || 0);
        rec.baselineRaw = 0;
        rec.lastRaw = rawTotal;
        rec.updatedAt = now.getTime();
        dirty = true;
      } else if (rawTotal !== rec.lastRaw) {
        rec.lastRaw = rawTotal;
        rec.updatedAt = now.getTime();
        dirty = true;
      }
    }
  }

  if (dirty) {
    scheduleSaveTrafficRecords();
  }

  const lifetimeUsed = (rec.archivedLifetime || 0) + rawTotal;
  const monthlyUsed = Math.max(0, rawTotal - (rec.baselineRaw || 0));

  return {
    lifetimeUsed,
    monthlyUsed,
    rawTotal,
    baselineRaw: rec.baselineRaw || 0,
    month: rec.currentMonth,
    up,
    down,
    limit: Number(limitBytes) || 0
  };
}

// Shared client lookup
async function resolveClient(id) {
  const authHeaders = await getAuthHeaders();
  if (!authHeaders) return { status: 500, body: { success: false, msg: 'Panel Auth Failed' } };

  let apiRes = await panelFetch(`${PANEL_URL}/panel/api/inbounds/list`, { headers: authHeaders });
  if ((apiRes.status === 401 || apiRes.status === 302) && ADMIN_USER && ADMIN_PASS) {
    console.log('[Auth Fallback in resolveClient] Got ' + apiRes.status + ', trying /login session cookie fallback...');
    const cookie = await getSession(true);
    if (cookie) {
      authHeaders['Cookie'] = cookie;
      apiRes = await panelFetch(`${PANEL_URL}/panel/api/inbounds/list`, { headers: authHeaders });
    }
  }
  const data = await parseResponseJson(apiRes, 'resolveClient/inbounds');
  if (!data || !data.success || !Array.isArray(data.obj)) {
    return { status: 502, body: { success: false, msg: 'Bad response from panel' } };
  }

  let foundClient = null;
  let foundInbound = null;
  data.obj.forEach(inb => {
    if (inb.clientStats) {
      const client = inb.clientStats.find(c => c.email === id);
      if (client) { foundClient = client; foundInbound = inb; }
    }
  });
  if (!foundClient) return { status: 404, body: { success: false, msg: 'User email not found' } };

  const now = Date.now();
  const lastOnlineTs = Number(foundClient.lastOnline) || 0;
  // If user was active within last 3 minutes (180,000 ms), they are ONLINE / CONNECTED
  const isOnline = lastOnlineTs > 0 ? ((now - lastOnlineTs) < 180000) : false;
  let ips = [];

  let serverInfo = null;
  try {
    const sData = await cachedJson('server_health', 5, async () => {
      const apiRes = await panelFetch(`${PANEL_URL}/panel/api/server/status`, {
        method: 'GET', headers: authHeaders
      });
      return await parseResponseJson(apiRes, 'resolveClient/status');
    });
    if (sData && sData.obj) {
      const s = sData.obj;
      serverInfo = {
        xray: { version: s.xray?.version || '' },
        uptime: s.uptime || 0,
        tcpCount: s.tcpCount || 0,
        udpCount: s.udpCount || 0,
        disk: s.disk || null
      };
    }
  } catch (e) {}

  let subLink = null, vlessLink = null, vmessLink = null, trojanLink = null, protocol = 'vless';
  try {
    let cleanBaseUrl = '';
    let publicHost = '';
    try {
      const pUri = new URL(PANEL_URL);
      // Strip any secret web base path (/ghc4...) so it is NEVER disclosed to clients
      cleanBaseUrl = `${pUri.protocol}//${pUri.host}`;
      publicHost = process.env.PUBLIC_DOMAIN || pUri.hostname;
    } catch (e) {
      publicHost = process.env.PUBLIC_DOMAIN || 'localhost';
      cleanBaseUrl = 'http://' + publicHost;
    }
    const host = publicHost;
    subLink = foundClient.subId ? `${cleanBaseUrl}/sub/${foundClient.subId}` : null;

    if (foundInbound) {
      const stream = JSON.parse(foundInbound.streamSettings || '{}');
      const port = foundInbound.port;
      const remark = foundInbound.remark || String(port);
      const network = stream.network || 'tcp';
      const security = stream.security || 'none';
      protocol = (foundInbound.protocol || 'vless').toLowerCase();

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
        } else if (network === 'tcp') {
          const tcp = stream.tcpSettings || {};
          if (tcp.header?.type === 'http') qs.set('headerType', 'http');
        }
        if (security === 'tls') {
          qs.set('security', 'tls');
          const tls = stream.tlsSettings || {};
          qs.set('sni', tls.serverName || host);
          const alpn = Array.isArray(tls.alpn) ? tls.alpn.join(',') : '';
          if (alpn) qs.set('alpn', alpn);
          const fp = tls.settings?.fingerprint || '';
          if (fp) qs.set('fp', fp);
          if (tls.settings?.allowInsecure) qs.set('allowInsecure', '1');
        } else if (security === 'reality') {
          qs.set('security', 'reality');
          const reality = stream.realitySettings || {};
          qs.set('sni', (reality.serverNames || [])[0] || host);
          qs.set('pbk', reality.publicKey || '');
          if (reality.shortIds?.[0]) qs.set('sid', reality.shortIds[0]);
          qs.set('fp', reality.settings?.fingerprint || 'chrome');
        }
        return qs;
      };

      if (protocol === 'vless') {
        const qs = buildQs();
        qs.set('encryption', 'none');
        const settings = JSON.parse(foundInbound.settings || '{}');
        const clientConf = (settings.clients || []).find(c => c.email === foundClient.email);
        if (clientConf?.flow) qs.set('flow', clientConf.flow);
        vlessLink = `vless://${foundClient.uuid}@${host}:${port}?${qs.toString()}#${encodeURIComponent(`${remark}-${foundClient.email}`)}`;
      } else if (protocol === 'vmess') {
        const vmessObj = {
          v: '2', ps: `${remark}-${foundClient.email}`, add: host,
          port: String(port), id: foundClient.uuid, aid: '0', scy: 'auto', net: network, type: 'none',
          host: network === 'ws' ? (stream.wsSettings?.headers?.Host || host) : '',
          path: network === 'ws' ? (stream.wsSettings?.path || '/') : '',
          tls: security === 'tls' ? 'tls' : ''
        };
        vmessLink = `vmess://${Buffer.from(JSON.stringify(vmessObj)).toString('base64')}`;
      } else if (protocol === 'trojan') {
        const qs = buildQs();
        trojanLink = `trojan://${foundClient.password || foundClient.uuid}@${host}:${port}?${qs.toString()}#${encodeURIComponent(`${remark}-${foundClient.email}`)}`;
      }
    }
  } catch (e) {}

  const configLink = vlessLink || vmessLink || trojanLink || null;

  let subInfo = null;
  if (subLink) {
    try {
      const siRes = await panelFetch(`${subLink}?format=info`, {
        headers: { ...authHeaders, 'User-Agent': 'ClashforWindows/0.20.0' }
      });
      const sct = siRes.headers.get('content-type') || '';
      if (sct.includes('json')) {
        const sj = await siRes.json().catch(() => null);
        if (sj && (sj.upload !== undefined || sj.download !== undefined)) subInfo = sj;
      }
      if (!subInfo) {
        const hdr = siRes.headers.get('Subscription-Userinfo') || '';
        if (hdr) {
          subInfo = {};
          hdr.split(';').forEach(p => {
            const [k, v] = p.trim().split('=');
            if (k && v !== undefined) subInfo[k.trim()] = Number(v.trim());
          });
        }
      }
    } catch (e) {}
  }

  const trafficMetrics = getClientTrafficMetrics(
    foundClient.email,
    foundClient.up,
    foundClient.down,
    foundClient.total
  );

  return {
    status: 200,
    body: {
      success: true, role: 'client',
      clientData: {
        email: foundClient.email,
        up: foundClient.up || 0,
        down: foundClient.down || 0,
        total: foundClient.total || 0,
        expiryTime: foundClient.expiryTime || 0,
        enable: foundClient.enable !== false,
        uuid: foundClient.uuid || foundClient.id,
        subId: foundClient.subId,
        lastOnline: foundClient.lastOnline || 0,
        serverInfo,
        isOnline,
        ips: MASK_VPS_DETAILS ? [] : ips,
        subLink,
        vlessLink,
        vmessLink,
        trojanLink,
        configLink,
        protocol,
        subInfo,
        traffic: trafficMetrics
      }
    }
  };
}

// Admin auth guard (Bearer <PANEL_PASSWORD> or API token)
function isAdmin(req) {
  if (!ADMIN_LOGIN_ENABLED) return false;
  const auth = req.headers.authorization;
  if (!auth) return false;
  if (ADMIN_PASS && auth === `Bearer ${ADMIN_PASS}`) return true;
  if (PANEL_API_TOKEN && auth === `Bearer ${PANEL_API_TOKEN}`) return true;
  return false;
}
function requireAdmin(req, res, next) {
  if (!ADMIN_LOGIN_ENABLED) {
    return res.status(403).json({ success: false, msg: 'Admin access is temporarily disabled' });
  }
  if (!isAdmin(req)) return res.status(401).json({ success: false, msg: 'Unauthorized' });
  next();
}

app.use(cors());
app.use('/api/xui', express.raw({ type: () => true, limit: '64mb' }));
app.use(express.json({ limit: '2mb' }));


// Lightweight server health endpoint for live status strip (Xray, conns, uptime, disk)
app.get('/api/server-info', async (req, res) => {
  try {
    const authHeaders = await getAuthHeaders();
    if (!authHeaders) return res.status(500).json({ success: false, msg: 'Auth failed' });
    const sData = await cachedJson('server_health', 5, async () => {
      const apiRes = await panelFetch(`${PANEL_URL}/panel/api/server/status`, {
        method: 'GET', headers: authHeaders
      });
      return await parseResponseJson(apiRes, 'api/server-info');
    });
    if (sData && sData.obj) {
      const s = sData.obj;
      return res.json({
        success: true,
        obj: {
          xray: { version: s.xray?.version || '' },
          uptime: s.uptime || 0,
          tcpCount: s.tcpCount || 0,
          udpCount: s.udpCount || 0,
          disk: s.disk || null
        }
      });
    }
    return res.status(502).json({ success: false });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

async function handleClientAuth(id, res) {
  try {
    const out = await resolveClient(id);
    return res.status(out.status).json(out.body);
  } catch (e) {
    _session = { cookie: null, ts: 0 };
    console.error('[Client Auth 500 Error]', e.message);
    return res.status(500).json({ success: false, msg: 'Server connectivity error: ' + e.message });
  }
}

app.post('/api/auth', async (req, res) => {
  const body = req.body || {};
  if (body.type === 'admin') {
    if (!ADMIN_LOGIN_ENABLED) {
      return res.status(403).json({
        success: false,
        msg: 'Admin login is temporarily disabled. Only client access is currently available.'
      });
    }
    if (!ADMIN_USER || !ADMIN_PASS) {
      return res.status(500).json({
        success: false,
        msg: 'Admin credentials are not configured in server environment.'
      });
    }
    const matchesPass = body.username === ADMIN_USER && body.password === ADMIN_PASS;
    const matchesToken = PANEL_API_TOKEN && (body.password === PANEL_API_TOKEN || body.token === PANEL_API_TOKEN);
    if (matchesPass || matchesToken) {
      return res.json({ success: true, role: 'admin', token: PANEL_API_TOKEN || ADMIN_PASS });
    }
    return res.status(401).json({ success: false, msg: 'Invalid admin credentials' });
  }
  if (body.type === 'client') return handleClientAuth((body.id || '').trim(), res);
  return res.status(400).json({ success: false, msg: 'Unsupported' });
});

app.post('/public/auth', (req, res) => {
  const body = req.body || {};
  if (body.type !== 'client') return res.status(400).json({ success: false, msg: 'Unsupported' });
  return handleClientAuth((body.id || '').trim(), res);
});

app.get('/api/ping', async (req, res) => {
  const t0 = Date.now();
  let vpsToInternet = 0;
  try {
    const tInt = Date.now();
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 2000);
    // Ping an ultra-fast global DNS/HTTP endpoint (1.1.1.1) to measure VPS -> Internet latency
    await fetch('https://1.1.1.1', { method: 'HEAD', signal: ctrl.signal }).catch(() => {});
    clearTimeout(tid);
    vpsToInternet = Math.max(1, Date.now() - tInt);
  } catch (e) {
    vpsToInternet = 18;
  }
  try { await panelFetch(`${PANEL_URL}/`, { method: 'HEAD' }); } catch (e) {}
  const vpsInternal = Date.now() - t0;
  res.set('Cache-Control', 'no-store').json({ 
    latency: vpsInternal,
    vpsToInternet,
    ts: Date.now() 
  });
});

app.get('/api/settings', requireAdmin, (req, res) => {
  res.json({
    success: true,
    hasApiToken: !!PANEL_API_TOKEN,
    adminLoginEnabled: ADMIN_LOGIN_ENABLED,
    maskVpsDetails: MASK_VPS_DETAILS
  });
});

app.all('/api/xui/*', requireAdmin, async (req, res) => {
  try {
    const authHeaders = await getAuthHeaders();
    if (!authHeaders) return res.status(401).json({ success: false, msg: 'Panel Auth Failed' });

    const queryStr = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const subPath = req.path.replace(/^\/api\/xui\//, '').replace(/^\/+/, '');
    const targetUrl = `${PANEL_URL}/panel/api/${subPath}${queryStr}`;

    const headers = { ...authHeaders };
    const ct = req.headers['content-type'];
    if (ct) headers['Content-Type'] = ct;

    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      body = Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined;
    }

    const proxied = await panelFetch(targetUrl, { method: req.method, headers, body });
    const text = await proxied.text();
    res.status(proxied.status)
      .set('Content-Type', proxied.headers.get('content-type') || 'application/json')
      .send(text);
  } catch (err) {
    _session = { cookie: null, ts: 0 };
    console.error('[API 500 Error]', req.method, req.originalUrl, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

async function fetchInbounds(authHeaders) {
  const headers = authHeaders || await getAuthHeaders();
  if (!headers) throw new Error('Panel Auth Failed');
  let apiRes = await panelFetch(`${PANEL_URL}/panel/api/inbounds/list`, {
    method: 'GET', headers
  });
  if ((apiRes.status === 401 || apiRes.status === 302) && ADMIN_USER && ADMIN_PASS) {
    console.log('[Auth Fallback] Got ' + apiRes.status + ', trying /login session cookie fallback...');
    const cookie = await getSession(true);
    if (cookie) {
      headers['Cookie'] = cookie;
      apiRes = await panelFetch(`${PANEL_URL}/panel/api/inbounds/list`, { method: 'GET', headers });
    }
  }
  return await parseResponseJson(apiRes, 'inbounds/list');
}

app.get('/api/expiry-alerts', requireAdmin, async (req, res) => {
  try {
    const authHeaders = await getAuthHeaders();
    if (!authHeaders) return res.status(401).json({ success: false, msg: 'Panel Auth Failed' });
    const data = await fetchInbounds(authHeaders);
    const alerts = [];
    const now = Date.now();
    const WARN_30 = 30 * 24 * 60 * 60 * 1000;
    if (data && data.obj) {
      data.obj.forEach(inb => {
        (inb.clientStats || []).forEach(c => {
          const exp = Number(c.expiryTime);
          if (exp > 0) {
            const diff = exp - now;
            if (diff <= WARN_30) {
              alerts.push({
                email: c.email, expiryTime: exp,
                daysLeft: Math.ceil(diff / (24 * 60 * 60 * 1000)),
                enable: c.enable, inboundId: inb.id, inboundRemark: inb.remark || String(inb.id)
              });
            }
          }
        });
      });
    }
    alerts.sort((a, b) => a.expiryTime - b.expiryTime);
    res.json({ success: true, obj: alerts });
  } catch (err) {
    _session = { cookie: null, ts: 0 };
    console.error('[API 500 Error]', req.method, req.originalUrl, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/system-history', requireAdmin, (req, res) => {
  const points = [];
  for (let i = 0; i < 10; i++) {
    const idx = _sysHistory.length - 10 + i;
    points.push(idx >= 0 ? _sysHistory[idx] : { time: '', cpu: 0, ram: 0 });
  }
  res.json({ success: true, obj: points });
});

app.get('/api/clients', requireAdmin, async (req, res) => {
  try {
    const authHeaders = await getAuthHeaders();
    if (!authHeaders) return res.status(401).json({ success: false, msg: 'Panel Auth Failed' });
    const data = await fetchInbounds(authHeaders);
    const clients = [];
    if (data && data.obj) {
      data.obj.forEach(inb => {
        (inb.clientStats || []).forEach(c =>
          clients.push({ ...c, inboundId: inb.id, inboundRemark: inb.remark || String(inb.id), protocol: inb.protocol }));
      });
    }
    res.json({ success: true, obj: clients });
  } catch (err) {
    _session = { cookie: null, ts: 0 };
    console.error('[API 500 Error]', req.method, req.originalUrl, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/history', requireAdmin, (req, res) => {
  res.json({
    success: true,
    obj: { dates: ['M', 'T', 'W', 'T', 'F', 'S', 'S'], up: [1, 2, 3, 2, 4, 5, 8], down: [10, 15, 12, 18, 20, 25, 30] }
  });
});

app.get('/api/status', requireAdmin, async (req, res) => {
  try {
    const authHeaders = await getAuthHeaders();
    if (!authHeaders) return res.status(401).json({ success: false, msg: 'Panel Auth Failed' });
    let apiRes = await panelFetch(`${PANEL_URL}/panel/api/server/status`, {
      method: 'GET', headers: authHeaders
    });
    if ((apiRes.status === 401 || apiRes.status === 302) && ADMIN_USER && ADMIN_PASS) {
      const cookie = await getSession(true);
      if (cookie) {
        authHeaders['Cookie'] = cookie;
        apiRes = await panelFetch(`${PANEL_URL}/panel/api/server/status`, { method: 'GET', headers: authHeaders });
      }
    }
    const data = await parseResponseJson(apiRes, 'server/status');
    if (data && data.obj) {
      if (MASK_VPS_DETAILS && data.obj.publicIP) {
        data.obj.publicIP = { ipv4: 'Protected', ipv6: 'Protected' };
      }
      pushHistory(data.obj);
    }
    res.json({ success: true, obj: data.obj || data });
  } catch (err) {
    _session = { cookie: null, ts: 0 };
    console.error('[API 500 Error]', req.method, req.originalUrl, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/inbounds', requireAdmin, async (req, res) => {
  try {
    const authHeaders = await getAuthHeaders();
    if (!authHeaders) return res.status(401).json({ success: false, msg: 'Panel Auth Failed' });
    const data = await fetchInbounds(authHeaders);
    res.json({ success: true, obj: data.obj || data });
  } catch (err) {
    _session = { cookie: null, ts: 0 };
    console.error('[API 500 Error]', req.method, req.originalUrl, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

function sseInit(res) {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
}
function sseSend(res, event, dataObj) {
  const payload = typeof dataObj === 'string' ? dataObj : JSON.stringify(dataObj);
  res.write(`event: ${event}\ndata: ${payload}\n\n`);
}

app.get('/api/stream', requireAdmin, async (req, res) => {
  sseInit(res);
  let closed = false;
  req.on('close', () => { closed = true; });

  sseSend(res, 'hello', { ok: true, intervalMs: INTERVAL_MS, cacheTtlSeconds: CACHE_TTL_S, ts: Date.now() });

  const fetchStatusCached = () => cachedJson('status', CACHE_TTL_S, async () => {
    const authHeaders = await getAuthHeaders();
    if (!authHeaders) throw new Error('Panel Auth Failed');
    const apiRes = await panelFetch(`${PANEL_URL}/panel/api/server/status`, {
      method: 'GET', headers: authHeaders
    });
    return await parseResponseJson(apiRes, 'stream/status');
  });

  while (!closed) {
    let status;
    try { status = await fetchStatusCached(); } catch (e) { status = { success: false, msg: String(e?.message || e) }; }
    if (closed) break;
    sseSend(res, 'metrics', { ts: Date.now(), status });
    res.write(`: ping ${Date.now()}\n\n`);
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
  try { res.end(); } catch (e) {}
});

app.get('/public/stream', async (req, res) => {
  const id = (req.query.id || '').toString().trim();
  if (!id) return res.status(400).json({ success: false, msg: 'Missing id' });

  sseInit(res);
  let closed = false;
  req.on('close', () => { closed = true; });

  sseSend(res, 'hello', { ok: true, intervalMs: INTERVAL_MS, cacheTtlSeconds: CACHE_TTL_S, ts: Date.now() });

  const findClient = (inboundsData) => {
    if (!inboundsData || !inboundsData.success || !Array.isArray(inboundsData.obj)) return null;
    let found = null;
    inboundsData.obj.forEach(inb => {
      const stats = inb?.clientStats;
      if (!Array.isArray(stats)) return;
      const c = stats.find(x => String(x.email) === id);
      if (c) found = { ...c, inboundId: inb.id };
    });
    return found;
  };

  while (!closed) {
    try {
      const authHeaders = await getAuthHeaders();
      if (!authHeaders) { sseSend(res, 'error', { msg: 'Panel Auth Failed' }); await new Promise(r => setTimeout(r, INTERVAL_MS)); continue; }
      const inbounds = await cachedJson('inbounds', CACHE_TTL_S, () => fetchInbounds(authHeaders));
      const client = findClient(inbounds);
      if (closed) break;
      if (!client) {
        sseSend(res, 'notfound', { id, ts: Date.now() });
      } else {
        const isOnline = client.lastOnline > 0 && ((Date.now() - Number(client.lastOnline)) < 180000);
        const trafficMetrics = getClientTrafficMetrics(
          client.email,
          client.up,
          client.down,
          client.total
        );
        sseSend(res, 'client', {
          ts: Date.now(), email: client.email, down: client.down, up: client.up,
          total: client.total, enable: client.enable, lastOnline: client.lastOnline,
          isOnline: isOnline,
          uuid: client.uuid, subId: client.subId,
          traffic: trafficMetrics
        });
      }
      res.write(`: ping ${Date.now()}\n\n`);
    } catch (e) {
      sseSend(res, 'error', { msg: String(e?.message || e) });
    }
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
  try { res.end(); } catch (e) {}
});

// Dedicated client traffic endpoint
app.get('/api/clients/traffic/:email', async (req, res) => {
  try {
    const email = (req.params.email || '').trim();
    if (!email) return res.status(400).json({ success: false, msg: 'Missing email' });
    const out = await resolveClient(email);
    if (out.status === 200 && out.body?.clientData) {
      return res.json({ success: true, traffic: out.body.clientData.traffic, client: out.body.clientData });
    }
    return res.status(out.status).json(out.body);
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.use(express.static(path.join(__dirname), { index: 'index.html', extensions: ['html'] }));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/public/')) {
    return res.status(404).json({ success: false, msg: 'Endpoint not found' });
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`3x-ui dashboard listening on http://0.0.0.0:${PORT}`);
  console.log(`Admin Login: ${ADMIN_LOGIN_ENABLED ? 'ENABLED' : 'TEMPORARILY DISABLED'}`);
});
