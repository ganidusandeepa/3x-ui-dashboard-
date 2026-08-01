// Node/Express server for self-hosting the 3x-ui dashboard (e.g. on the same
// VPS as the panel, deployed via Coolify/Docker). This faithfully mirrors the
// Cloudflare Functions in functions/api/[[path]].js, functions/api/stream.js
// and functions/public/stream.js so behavior is identical whether hosted on
// Cloudflare Pages or a Node container.
//
// Config comes from environment variables:
//   PANEL_URL        e.g. http://127.0.0.1:2053   (the local 3x-ui panel)
//   PANEL_USERNAME   panel admin username (used only if PANEL_API_TOKEN is unset)
//   PANEL_PASSWORD   panel admin password (also the dashboard admin token)
//   PANEL_API_TOKEN  panel Settings -> Security -> API Token (Bearer). Preferred
//                    over username/password when set — skips login entirely.
//   PANEL_NODES      optional JSON array of extra node panels to search when a
//                    client isn't found on the master panel, e.g.:
//                    [{"name":"Node1","url":"https://node1.example.com:2053/base","apiToken":"..."}]
//   PORT             HTTP port to listen on (default 8080)
//   METRICS_INTERVAL_MS / METRICS_CACHE_TTL   optional SSE tuning

const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();

const PANEL_URL_RAW = process.env.PANEL_URL || 'http://127.0.0.1:2053';
const PANEL_URL = PANEL_URL_RAW.replace(/\/$/, '');
const ADMIN_USER = process.env.PANEL_USERNAME || 'admin';
const ADMIN_PASS = process.env.PANEL_PASSWORD || 'password';
const PANEL_API_TOKEN = process.env.PANEL_API_TOKEN || null;
const PORT = Number(process.env.PORT || 8080);

// Optional: extra node panels to search when a client isn't found on the
// master panel (e.g. clients added directly on a node's own UI). JSON array:
//   PANEL_NODES=[{"name":"Node1","url":"https://node1.example.com:2053/base","apiToken":"..."}]
// Each node's own API token is required — the master panel stores a
// registered node's token write-only and won't hand it back over the API.
let PANEL_NODES = [];
try {
  const raw = process.env.PANEL_NODES;
  if (raw) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) PANEL_NODES = parsed;
  }
} catch (e) { PANEL_NODES = []; }
const INTERVAL_MS = Math.max(1000, Number(process.env.METRICS_INTERVAL_MS || 3000));
const CACHE_TTL_S = Number(process.env.METRICS_CACHE_TTL || 3);

// ---- Session cache (18 min), mirrors the Worker module-level cache ----
let _session = { cookie: null, ts: 0 };
const SESSION_TTL = 18 * 60 * 1000;

// Tolerate settings/streamSettings returned as objects or JSON strings.
function parseMaybe(v, fallback) {
  if (v == null || v === '') return fallback || {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return fallback || {}; }
}
function normIp(x) {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object') return x.ip || x.address || x.clientIp || x.remote || '';
  return '';
}

// Maintenance mode — when true, admin sign-in is blocked. Flip to false (and in
// functions/api/[[path]].js + main.js) to re-enable admin access.
const ADMIN_MAINTENANCE = true;

async function getSession(force = false) {
  // If an API token is configured, use it directly — no session/login needed.
  if (PANEL_API_TOKEN) return 'token';

  const now = Date.now();
  if (!force && _session.cookie && now - _session.ts < SESSION_TTL) {
    return _session.cookie;
  }

  // Try 3x-ui 3.6.0+ JSON login first.
  try {
    const r = await fetch(`${PANEL_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
      redirect: 'follow'
    });
    const c = r.headers.get('set-cookie');
    if (c) { _session = { cookie: c, ts: now }; return c; }
  } catch (e) {}

  // Fallback to the legacy form-encoded /login.
  const loginRes = await fetch(`${PANEL_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
    redirect: 'follow'
  });
  const cookie = loginRes.headers.get('set-cookie');
  if (cookie) _session = { cookie, ts: now };
  return cookie;
}

// Build panel-request headers: Bearer token when configured, otherwise the
// session cookie. Used for EVERY fetch to the panel so the token actually
// takes effect everywhere (client lookup, admin proxy, SSE, etc).
function panelHeaders(cookie, extra) {
  return Object.assign({}, extra || {},
    PANEL_API_TOKEN ? { Authorization: `Bearer ${PANEL_API_TOKEN}` } : { Cookie: cookie });
}

// ---- Rolling CPU/RAM history buffer ----
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

// ---- Tiny in-memory TTL cache (replaces Cloudflare caches.default) ----
const _cache = new Map();
async function cachedJson(key, ttlS, producer) {
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && now - hit.ts < ttlS * 1000) return hit.value;
  const value = await producer();
  _cache.set(key, { ts: now, value });
  return value;
}

// ---- Client lookup + config-link builder, scoped to ONE panel (master or a
// node) so the same logic can search either. Returns the clientData object,
// or null if this panel doesn't have the client (so the caller can try the
// next one) or is unreachable. ----
async function resolveClientFromPanel(baseUrl, authHeaders, id, sourceLabel) {
  const h = (extra) => Object.assign({}, extra || {}, authHeaders);

  let data;
  try {
    const apiRes = await fetch(`${baseUrl}/panel/api/inbounds/list`, { headers: h() });
    data = await apiRes.json();
  } catch (e) { return null; }
  if (!data || !data.success || !Array.isArray(data.obj)) return null;

  let foundClient = null;
  let foundInbound = null;
  data.obj.forEach(inb => {
    if (inb.clientStats) {
      const client = inb.clientStats.find(c => c.email === id);
      if (client) { foundClient = client; foundInbound = inb; }
    }
  });
  if (!foundClient) return null;

  let isOnline = null;
  let ips = [];
  // 3x-ui moved these to /panel/api/clients/*; fall back to legacy /panel/api/inbounds/* on older panels.
  try {
    for (const p of ['clients/onlines', 'inbounds/onlines']) {
      try {
        const onRes = await fetch(`${baseUrl}/panel/api/${p}`, {
          method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({})
        });
        const onData = await onRes.json();
        if (onData && onData.success && Array.isArray(onData.obj)) { isOnline = onData.obj.includes(foundClient.email); break; }
      } catch (e) {}
    }
  } catch (e) {}

  try {
    const em = encodeURIComponent(foundClient.email);
    for (const p of [`clients/ips/${em}`, `inbounds/clientIps/${em}`]) {
      try {
        const ipRes = await fetch(`${baseUrl}/panel/api/${p}`, {
          method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({})
        });
        const ipData = await ipRes.json();
        if (ipData && ipData.success) {
          if (Array.isArray(ipData.obj)) { ips = ipData.obj.map(normIp).filter(Boolean); break; }
          if (typeof ipData.obj === 'string' && ipData.obj && !/no ip/i.test(ipData.obj)) { ips = ipData.obj.split(/[,\s]+/).filter(Boolean); break; }
        }
      } catch (e) {}
    }
  } catch (e) {}

  // New client-scoped extras: all config links, all subscription links, last-seen.
  let allLinks = [], subProtoLinks = [], lastOnlineTs = 0;
  const normLinks = (obj) => Array.isArray(obj) ? obj.map(x => {
    if (typeof x === 'string') return { remark: '', link: x };
    if (x && typeof x === 'object') return { remark: x.remark || x.name || x.tag || '', link: x.link || x.url || x.uri || '' };
    return null;
  }).filter(x => x && x.link) : [];
  try {
    const r = await fetch(`${baseUrl}/panel/api/clients/links/${encodeURIComponent(foundClient.email)}`, { headers: h({ Accept: 'application/json' }) });
    const j = await r.json(); if (j && j.success) allLinks = normLinks(j.obj);
  } catch (e) {}
  try {
    if (foundClient.subId) {
      const r = await fetch(`${baseUrl}/panel/api/clients/subLinks/${encodeURIComponent(foundClient.subId)}`, { headers: h({ Accept: 'application/json' }) });
      const j = await r.json();
      if (j && j.success && Array.isArray(j.obj)) subProtoLinks = j.obj.map(x => typeof x === 'string' ? x : (x && (x.link || x.url || x.uri))).filter(Boolean);
    }
  } catch (e) {}
  try {
    const r = await fetch(`${baseUrl}/panel/api/clients/lastOnline`, { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({}) });
    const j = await r.json();
    if (j && j.success && j.obj && typeof j.obj === 'object') {
      let ts = Number(j.obj[foundClient.email] || 0);
      if (ts > 0 && ts < 1e12) ts *= 1000;
      lastOnlineTs = ts || 0;
    }
  } catch (e) {}

  // Config links point at THIS panel's own host — for a node-resolved client
  // that's the node's address (where its Xray inbound actually lives), not
  // the master's.
  let subLink = null, vlessLink = null, vmessLink = null, trojanLink = null, protocol = 'vless';
  try {
    const host = new URL(baseUrl).hostname;
    subLink = foundClient.subId ? `${baseUrl}/sub/${foundClient.subId}` : null;

    if (foundInbound) {
      const stream = parseMaybe(foundInbound.streamSettings);
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
        const settings = parseMaybe(foundInbound.settings);
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
      const siRes = await fetch(`${subLink}?format=info`, {
        headers: h({ 'User-Agent': 'ClashforWindows/0.20.0' })
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

  return { ...foundClient, isOnline, subLink, vlessLink, vmessLink, trojanLink, configLink, protocol, subInfo, allLinks, subProtoLinks, lastOnlineTs, sourceNode: sourceLabel || null };
}

// ---- Shared client lookup (mirrors /api auth 'client') ----
// Searches the master panel first, then falls back to each configured node's
// own panel (see PANEL_NODES) so a client added directly on a node's UI still
// resolves to a full dashboard, exactly like a master-panel client.
async function resolveClient(id) {
  const cookie = await getSession();
  if (!cookie) return { status: 500, body: { success: false, msg: 'Panel Auth Failed' } };

  let clientData = null;
  try { clientData = await resolveClientFromPanel(PANEL_URL, panelHeaders(cookie), id, null); } catch (e) {}

  if (!clientData) {
    for (const node of PANEL_NODES) {
      const nodeUrl = String(node?.url || '').replace(/\/$/, '');
      if (!nodeUrl || !node?.apiToken) continue;
      try {
        clientData = await resolveClientFromPanel(nodeUrl, { Authorization: `Bearer ${node.apiToken}` }, id, node.name || nodeUrl);
      } catch (e) {}
      if (clientData) break;
    }
  }

  if (!clientData) return { status: 404, body: { success: false, msg: 'User email not found' } };
  return { status: 200, body: { success: true, role: 'client', clientData } };
}

// ---- Admin auth guard (Bearer <PANEL_PASSWORD>) ----
function isAdmin(req) {
  return req.headers.authorization === `Bearer ${ADMIN_PASS}`;
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ success: false, msg: 'Unauthorized' });
  next();
}

// ============================ Middleware ============================
app.use(cors());
// Raw body for the passthrough proxy (preserves multipart boundaries, e.g. importDB)
app.use('/api/xui', express.raw({ type: () => true, limit: '64mb' }));
app.use(express.json({ limit: '2mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ============================ Auth ============================
async function handleClientAuth(id, res) {
  try {
    const out = await resolveClient(id);
    return res.status(out.status).json(out.body);
  } catch (e) {
    _session = { cookie: null, ts: 0 };
    return res.status(500).json({ success: false, msg: 'Server connectivity error' });
  }
}

app.post('/api/auth', async (req, res) => {
  const body = req.body || {};
  if (body.type === 'admin') {
    if (ADMIN_MAINTENANCE) {
      return res.status(503).json({ success: false, maintenance: true, msg: 'Admin panel is under maintenance. Please check back later.' });
    }
    if (body.username === ADMIN_USER && body.password === ADMIN_PASS) {
      return res.json({ success: true, role: 'admin' });
    }
    return res.status(401).json({ success: false, msg: 'Invalid admin credentials' });
  }
  if (body.type === 'client') return handleClientAuth((body.id || '').trim(), res);
  return res.status(400).json({ success: false, msg: 'Unsupported' });
});

// Legacy public client-auth endpoint (kept for compatibility)
app.post('/public/auth', (req, res) => {
  const body = req.body || {};
  if (body.type !== 'client') return res.status(400).json({ success: false, msg: 'Unsupported' });
  return handleClientAuth((body.id || '').trim(), res);
});

// ============================ Public ping ============================
app.get('/api/ping', async (req, res) => {
  const t0 = Date.now();
  try { await fetch(`${PANEL_URL}/`, { method: 'HEAD', signal: AbortSignal.timeout(6000) }); } catch (e) {}
  res.set('Cache-Control', 'no-store').json({ latency: Date.now() - t0, ts: t0 });
});

// ============================ Settings (admin) ============================
app.get('/api/settings', requireAdmin, (req, res) => {
  res.json({ success: true, panelUrl: PANEL_URL, username: ADMIN_USER });
});

// ============================ Generic panel proxy (admin) ============================
app.all('/api/xui/*', requireAdmin, async (req, res) => {
  try {
    const cookie = await getSession();
    if (!cookie) return res.status(401).json({ success: false, msg: 'Panel Auth Failed' });

    const subPath = req.path.replace(/^\/api\/xui\//, '').replace(/^\/+/, '');
    const targetUrl = `${PANEL_URL}/panel/api/${subPath}`;

    const headers = panelHeaders(cookie, { Accept: 'application/json', Referer: `${PANEL_URL}/` });
    const ct = req.headers['content-type'];
    if (ct) headers['Content-Type'] = ct; // preserve multipart boundary for importDB

    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      body = Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined;
    }

    const proxied = await fetch(targetUrl, { method: req.method, headers, body });
    const text = await proxied.text();
    res.status(proxied.status)
      .set('Content-Type', proxied.headers.get('content-type') || 'application/json')
      .send(text);
  } catch (err) {
    _session = { cookie: null, ts: 0 };
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================ Aggregated admin endpoints ============================
async function fetchInbounds(cookie) {
  const apiRes = await fetch(`${PANEL_URL}/panel/api/inbounds/list`, {
    method: 'GET', headers: panelHeaders(cookie, { Accept: 'application/json', Referer: `${PANEL_URL}/` })
  });
  return apiRes.json();
}

// ---- Per-panel cached fetchers for the public client SSE stream ----
// Keyed by baseUrl so master and each node cache independently.
async function fetchInboundsForPanel(baseUrl, authHeaders) {
  return cachedJson(`inbounds:${baseUrl}`, CACHE_TTL_S, async () => {
    const apiRes = await fetch(`${baseUrl}/panel/api/inbounds/list`, { headers: authHeaders });
    return apiRes.json();
  });
}
async function fetchOnlinesForPanel(baseUrl, authHeaders) {
  return cachedJson(`onlines:${baseUrl}`, CACHE_TTL_S, async () => {
    for (const p of ['clients/onlines', 'inbounds/onlines']) {
      try {
        const r = await fetch(`${baseUrl}/panel/api/${p}`, {
          method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders), body: JSON.stringify({})
        });
        const j = await r.json();
        if (j && j.success && Array.isArray(j.obj)) return j.obj;
      } catch (e) {}
    }
    return [];
  });
}
// All panels (master + configured nodes) to search, in order.
function panelTargets(cookie) {
  const list = [{ baseUrl: PANEL_URL, headers: panelHeaders(cookie) }];
  for (const node of PANEL_NODES) {
    const nodeUrl = String(node?.url || '').replace(/\/$/, '');
    if (nodeUrl && node?.apiToken) list.push({ baseUrl: nodeUrl, headers: { Authorization: `Bearer ${node.apiToken}` } });
  }
  return list;
}

app.get('/api/expiry-alerts', requireAdmin, async (req, res) => {
  try {
    const cookie = await getSession();
    if (!cookie) return res.status(401).json({ success: false, msg: 'Panel Auth Failed' });
    const data = await fetchInbounds(cookie);
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
    const cookie = await getSession();
    if (!cookie) return res.status(401).json({ success: false, msg: 'Panel Auth Failed' });
    const data = await fetchInbounds(cookie);
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
    const cookie = await getSession();
    if (!cookie) return res.status(401).json({ success: false, msg: 'Panel Auth Failed' });
    const apiRes = await fetch(`${PANEL_URL}/panel/api/server/status`, {
      method: 'GET', headers: panelHeaders(cookie, { Accept: 'application/json', Referer: `${PANEL_URL}/` })
    });
    const data = await apiRes.json();
    if (data && data.obj) pushHistory(data.obj);
    res.json({ success: true, obj: data.obj || data });
  } catch (err) {
    _session = { cookie: null, ts: 0 };
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/inbounds', requireAdmin, async (req, res) => {
  try {
    const cookie = await getSession();
    if (!cookie) return res.status(401).json({ success: false, msg: 'Panel Auth Failed' });
    const data = await fetchInbounds(cookie);
    res.json({ success: true, obj: data.obj || data });
  } catch (err) {
    _session = { cookie: null, ts: 0 };
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================ SSE: admin metrics ============================
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
    const cookie = await getSession();
    if (!cookie) throw new Error('Panel Auth Failed');
    const apiRes = await fetch(`${PANEL_URL}/panel/api/server/status`, {
      method: 'GET', headers: panelHeaders(cookie, { Accept: 'application/json', Referer: `${PANEL_URL}/` })
    });
    const data = await apiRes.json();
    return { success: true, obj: data.obj || data };
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

// ============================ SSE: public client traffic ============================
app.get('/public/stream', async (req, res) => {
  const id = (req.query.id || '').toString().trim();
  if (!id) return res.status(400).json({ success: false, msg: 'Missing id' });

  sseInit(res);
  let closed = false;
  req.on('close', () => { closed = true; });

  sseSend(res, 'hello', { ok: true, intervalMs: INTERVAL_MS, cacheTtlSeconds: CACHE_TTL_S, ts: Date.now() });

  const findClientIn = (inboundsData) => {
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
      const cookie = await getSession();
      if (!cookie) { sseSend(res, 'error', { msg: 'Panel Auth Failed' }); await new Promise(r => setTimeout(r, INTERVAL_MS)); continue; }

      // Search master first, then each configured node — same fallback as
      // the initial /api/auth lookup, so a node-only client keeps updating.
      let client = null, clientPanel = null;
      for (const target of panelTargets(cookie)) {
        let inbounds;
        try { inbounds = await fetchInboundsForPanel(target.baseUrl, target.headers); } catch (e) { continue; }
        const found = findClientIn(inbounds);
        if (found) { client = found; clientPanel = target; break; }
      }

      if (closed) break;
      if (!client) {
        sseSend(res, 'notfound', { id, ts: Date.now() });
      } else {
        // Authoritative online status each tick, from the SAME panel the
        // client was found on, so the pill doesn't flip back to AWAY.
        let isOnline = false;
        try {
          const onlines = await fetchOnlinesForPanel(clientPanel.baseUrl, clientPanel.headers);
          if (Array.isArray(onlines)) isOnline = onlines.includes(client.email);
        } catch (e) {}

        sseSend(res, 'client', {
          ts: Date.now(), email: client.email, down: client.down, up: client.up,
          total: client.total, enable: client.enable, isOnline, lastOnline: client.lastOnline,
          uuid: client.uuid, subId: client.subId
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

// ============================ Static assets + SPA fallback ============================
app.use(express.static(path.join(__dirname), { index: 'index.html', extensions: ['html'] }));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/public/')) {
    return res.status(404).json({ success: false, msg: 'Endpoint not found' });
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`3x-ui dashboard listening on http://0.0.0.0:${PORT}`);
  console.log(`Proxying panel at ${PANEL_URL} (user: ${ADMIN_USER})`);
});
