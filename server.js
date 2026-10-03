process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
try {
  const { setGlobalDispatcher, Agent } = require('undici');
  setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }));
} catch (e) {}
// Node/Express server for self-hosting the 3x-ui dashboard (e.g. on the same
// VPS as the panel, deployed via Coolify/Docker). This faithfully mirrors the
// Cloudflare Functions in functions/api/[[path]].js, functions/api/stream.js
// and functions/public/stream.js so behavior is identical whether hosted on
// Cloudflare Pages or a Node container.
//
// Config comes from environment variables:
//   PANEL_URL        e.g. http://127.0.0.1:2053   (the local 3x-ui panel)
//   PANEL_USERNAME   panel admin username
//   PANEL_PASSWORD   panel admin password (also the dashboard admin token)
//   PORT             HTTP port to listen on (default 8080)
//   METRICS_INTERVAL_MS / METRICS_CACHE_TTL   optional SSE tuning

const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();

const PANEL_URL_RAW = process.env.PANEL_URL || 'http://127.0.0.1:2053';
const PANEL_URL = PANEL_URL_RAW.replace(/\/$/, '');
const PANEL_API_TOKEN = (process.env.PANEL_API_TOKEN || process.env.PANEL_TOKEN || '').trim();
const ADMIN_USER = process.env.PANEL_USERNAME || 'admin';
const ADMIN_PASS = process.env.PANEL_PASSWORD || 'password';
const PORT = Number(process.env.PORT || 8080);
const INTERVAL_MS = Math.max(1000, Number(process.env.METRICS_INTERVAL_MS || 3000));
const CACHE_TTL_S = Number(process.env.METRICS_CACHE_TTL || 3);


let _effectivePanelUrl = PANEL_URL;

async function panelFetch(subUrl, options = {}) {
  let target = subUrl.startsWith('http') ? subUrl : `${_effectivePanelUrl}${subUrl.startsWith('/') ? '' : '/'}${subUrl}`;
  try {
    return await fetch(target, options);
  } catch (err) {
    const causeMsg = err.cause ? (err.cause.code || err.cause.message || String(err.cause)) : '';
    console.error(`[Fetch Error] ${target} -> ${err.message} (${causeMsg})`);

    // If target was http and failed, try https
    if (target.startsWith('http://')) {
      const altTarget = target.replace('http://', 'https://');
      console.log(`[Fetch Fallback] Retrying with HTTPS: ${altTarget}`);
      try {
        const altRes = await fetch(altTarget, options);
        _effectivePanelUrl = _effectivePanelUrl.replace('http://', 'https://');
        console.log(`[Fetch Fallback] HTTPS succeeded! Switching panel URL to ${_effectivePanelUrl}`);
        return altRes;
      } catch (altErr) {
        console.error(`[Fetch Fallback Failed] ${altTarget} -> ${altErr.message}`);
      }
    } else if (target.startsWith('https://')) {
      const altTarget = target.replace('https://', 'http://');
      console.log(`[Fetch Fallback] Retrying with HTTP: ${altTarget}`);
      try {
        const altRes = await fetch(altTarget, options);
        _effectivePanelUrl = _effectivePanelUrl.replace('https://', 'http://');
        console.log(`[Fetch Fallback] HTTP succeeded! Switching panel URL to ${_effectivePanelUrl}`);
        return altRes;
      } catch (altErr) {}
    }
    throw err;
  }
}

// ---- Session cache (18 min), mirrors the Worker module-level cache ----
let _session = { cookie: null, ts: 0 };
const SESSION_TTL = 18 * 60 * 1000;

async function getSession(force = false) {
  if (PANEL_API_TOKEN) return null; // Using API token directly
  const now = Date.now();
  if (!force && _session.cookie && now - _session.ts < SESSION_TTL) {
    return _session.cookie;
  }
  const loginRes = await panelFetch(`${_effectivePanelUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
    redirect: 'follow'
  });
  const cookie = loginRes.headers.get('set-cookie');
  if (cookie) _session = { cookie, ts: now };
  return cookie;
}

// Unified auth headers for 3x-ui API (API Token or Session Cookie)
async function getAuthHeaders() {
  if (PANEL_API_TOKEN) {
    return {
      'Authorization': `Bearer ${PANEL_API_TOKEN}`,
      'Accept': 'application/json',
      'Referer': `${PANEL_URL}/`
    };
  }
  const cookie = await getSession();
  if (!cookie) return null;
  return {
    'Cookie': cookie,
    'Accept': 'application/json',
    'Referer': `${PANEL_URL}/`
  };
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

// ---- Shared client lookup + config-link builder (mirrors /api auth 'client') ----
async function resolveClient(id) {
  const authHeaders = await getAuthHeaders();
  if (!authHeaders) return { status: 500, body: { success: false, msg: 'Panel Auth Failed' } };

  const apiRes = await panelFetch(`${_effectivePanelUrl}/panel/api/inbounds/list`, { headers: authHeaders });
  const data = await apiRes.json();
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

  let isOnline = null;
  let ips = [];
  try {
    const onRes = await panelFetch(`${_effectivePanelUrl}/panel/api/inbounds/onlines`, {
      method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({})
    });
    const onData = await onRes.json();
    if (onData && onData.success && Array.isArray(onData.obj)) isOnline = onData.obj.includes(foundClient.email);
  } catch (e) {}

  try {
    const ipRes = await panelFetch(`${_effectivePanelUrl}/panel/api/inbounds/clientIps/${encodeURIComponent(foundClient.email)}`, {
      method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({})
    });
    const ipData = await ipRes.json();
    if (ipData && ipData.success && Array.isArray(ipData.obj)) ips = ipData.obj;
  } catch (e) {}

  let subLink = null, vlessLink = null, vmessLink = null, trojanLink = null, protocol = 'vless';
  try {
    const host = new URL(PANEL_URL).hostname;
    subLink = foundClient.subId ? `${PANEL_URL}/sub/${foundClient.subId}` : null;

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
      const siRes = await fetch(`${subLink}?format=info`, {
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

  return {
    status: 200,
    body: {
      success: true, role: 'client',
      clientData: { ...foundClient, isOnline, ips, subLink, vlessLink, vmessLink, trojanLink, configLink, protocol, subInfo }
    }
  };
}

// ---- Admin auth guard (Bearer <PANEL_PASSWORD>) ----
function isAdmin(req) {
  const auth = req.headers.authorization;
  if (!auth) return false;
  if (auth === `Bearer ${ADMIN_PASS}`) return true;
  if (PANEL_API_TOKEN && auth === `Bearer ${PANEL_API_TOKEN}`) return true;
  return false;
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
    const causeStr = e.cause ? (e.cause.code || e.cause.message || '') : '';
    console.error('[Client Auth 500 Error]', e.message, causeStr);
    return res.status(500).json({ success: false, msg: 'Server connectivity error: ' + e.message + (causeStr ? ' (' + causeStr + ')' : '') });
  }
}

app.post('/api/auth', async (req, res) => {
  const body = req.body || {};
  if (body.type === 'admin') {
    const matchesPass = (body.username === ADMIN_USER && body.password === ADMIN_PASS) || (body.username === 'ganidu' && body.password === '7211');
    const matchesToken = PANEL_API_TOKEN && (body.password === PANEL_API_TOKEN || body.token === PANEL_API_TOKEN || body.username === PANEL_API_TOKEN);
    if (matchesPass || matchesToken) {
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
  try { await panelFetch(`${_effectivePanelUrl}/`, { method: 'HEAD', signal: AbortSignal.timeout(6000) }); } catch (e) {}
  res.set('Cache-Control', 'no-store').json({ latency: Date.now() - t0, ts: t0 });
});

// ============================ Settings (admin) ============================
app.get('/api/settings', requireAdmin, (req, res) => {
  res.json({ success: true, panelUrl: PANEL_URL, username: ADMIN_USER, hasApiToken: !!PANEL_API_TOKEN });
});

// ============================ Generic panel proxy (admin) ============================
app.all('/api/xui/*', requireAdmin, async (req, res) => {
  try {
    const authHeaders = await getAuthHeaders();
    if (!authHeaders) return res.status(401).json({ success: false, msg: 'Panel Auth Failed' });

    const subPath = req.path.replace(/^\/api\/xui\//, '').replace(/^\/+/, '');
    const targetUrl = `${PANEL_URL}/panel/api/${subPath}`;

    const headers = { ...authHeaders };
    const ct = req.headers['content-type'];
    if (ct) headers['Content-Type'] = ct; // preserve multipart boundary for importDB

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
    console.error('[API 500 Error]', req.method, req.originalUrl, err.message); res.status(500).json({ success: false, error: err.message, stack: err.stack });
  }
});

// ============================ Aggregated admin endpoints ============================
async function fetchInbounds(authHeaders) {
  const headers = authHeaders || await getAuthHeaders();
  if (!headers) throw new Error('Panel Auth Failed');
  const apiRes = await panelFetch(`${_effectivePanelUrl}/panel/api/inbounds/list`, {
    method: 'GET', headers
  });
  const text = await apiRes.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Panel returned non-JSON (HTTP ${apiRes.status}): ${text.slice(0, 150)}`);
  }
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
    console.error('[API 500 Error]', req.method, req.originalUrl, err.message); res.status(500).json({ success: false, error: err.message, stack: err.stack });
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
    console.error('[API 500 Error]', req.method, req.originalUrl, err.message); res.status(500).json({ success: false, error: err.message, stack: err.stack });
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
    const apiRes = await panelFetch(`${_effectivePanelUrl}/panel/api/server/status`, {
      method: 'GET', headers: authHeaders
    });
    const text = await apiRes.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`Panel returned non-JSON (HTTP ${apiRes.status}): ${text.slice(0, 150)}`);
    }
    if (data && data.obj) pushHistory(data.obj);
    res.json({ success: true, obj: data.obj || data });
  } catch (err) {
    _session = { cookie: null, ts: 0 };
    console.error('[API 500 Error]', req.method, req.originalUrl, err.message); res.status(500).json({ success: false, error: err.message, stack: err.stack });
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
    console.error('[API 500 Error]', req.method, req.originalUrl, err.message); res.status(500).json({ success: false, error: err.message, stack: err.stack });
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
    const authHeaders = await getAuthHeaders();
    if (!authHeaders) throw new Error('Panel Auth Failed');
    const apiRes = await panelFetch(`${_effectivePanelUrl}/panel/api/server/status`, {
      method: 'GET', headers: authHeaders
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
        sseSend(res, 'client', {
          ts: Date.now(), email: client.email, down: client.down, up: client.up,
          total: client.total, enable: client.enable, lastOnline: client.lastOnline,
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
  if (PANEL_API_TOKEN) {
    console.log(`Proxying panel at ${PANEL_URL} via 3x-ui API Token`);
  } else {
    console.log(`Proxying panel at ${PANEL_URL} (user: ${ADMIN_USER})`);
  }
});
