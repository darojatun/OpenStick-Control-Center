'use strict';
/*
 * OpenStick Control Center
 * Backend Node.js (tanpa dependency) untuk mengontrol WiFi & 4G via nmcli (+ mmcli opsional).
 * Kompatibel Node.js >= 12.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.PORT || '80', 10);
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || '';
const HOTSPOT_NAME = 'Hotspot';
const INDEX_FILE = path.join(__dirname, 'index.html');

const IFNAME_RE = /^[A-Za-z0-9_.@-]{1,15}$/;
const UUID_RE = /^[0-9a-fA-F-]{36}$/;

/* ---------- util ---------- */

function httpError(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeout || 20000,
        maxBuffer: 1024 * 1024,
        env: Object.assign({}, process.env, { LC_ALL: 'C' }),
      },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') return reject(httpError(500, cmd + ' tidak ditemukan di sistem'));
          const msg = ((stderr || '').trim() || (stdout || '').trim() || err.message).replace(/^Error:\s*/, '');
          return reject(httpError(500, msg));
        }
        resolve(stdout);
      }
    );
  });
}

const nmcli = (args, timeout) => run('nmcli', args, timeout);

// Format terse nmcli: pemisah ':' dan karakter ':' / '\' di-escape dengan '\'
function splitTerse(line) {
  const out = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
    } else if (c === ':') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseTerse(txt, fields) {
  return txt
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const p = splitTerse(l);
      const o = {};
      fields.forEach((f, i) => (o[f] = p[i] === undefined ? '' : p[i]));
      return o;
    });
}

// Validasi field string dari body request
function need(body, key, opts) {
  opts = opts || {};
  let v = body[key];
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    throw httpError(400, 'Field "' + key + '" wajib diisi');
  }
  if (typeof v !== 'string') throw httpError(400, 'Field "' + key + '" harus berupa teks');
  const min = opts.min || 1;
  const max = opts.max || 64;
  if (v.length < min || v.length > max) {
    throw httpError(400, 'Field "' + key + '" harus ' + min + '-' + max + ' karakter');
  }
  if (v.indexOf('\0') >= 0) throw httpError(400, 'Field "' + key + '" tidak valid');
  if (opts.dash !== true && v[0] === '-') throw httpError(400, 'Field "' + key + '" tidak boleh diawali "-"');
  if (opts.re && !opts.re.test(v)) throw httpError(400, 'Field "' + key + '" tidak valid');
  return v;
}

const needIf = (body, opt) => need(body, 'ifname', { re: IFNAME_RE, optional: opt !== false });
const needUuid = (body) => need(body, 'uuid', { re: UUID_RE, min: 36, max: 36 });

/* ---------- data sistem ---------- */

function readTraffic() {
  const out = {};
  try {
    fs.readFileSync('/proc/net/dev', 'utf8')
      .split('\n')
      .slice(2)
      .forEach((l) => {
        const m = l.match(/^\s*([^:]+):\s*(.*)$/);
        if (!m) return;
        const f = m[2].trim().split(/\s+/).map(Number);
        out[m[1]] = { rx: f[0], tx: f[8] };
      });
  } catch (e) {
    /* abaikan */
  }
  return out;
}

function readSystem() {
  const s = {
    hostname: os.hostname(),
    uptime: os.uptime(),
    load: os.loadavg(),
    cpus: os.cpus().length,
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    temp: null,
  };
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/);
    if (m) s.memFree = parseInt(m[1], 10) * 1024;
  } catch (e) {
    /* abaikan */
  }
  try {
    let max = null;
    fs.readdirSync('/sys/class/thermal')
      .filter((n) => n.indexOf('thermal_zone') === 0)
      .forEach((n) => {
        try {
          const t = parseInt(fs.readFileSync('/sys/class/thermal/' + n + '/temp', 'utf8'), 10);
          if (!isNaN(t) && (max === null || t > max)) max = t;
        } catch (e) {
          /* abaikan */
        }
      });
    if (max !== null) s.temp = max > 1000 ? max / 1000 : max;
  } catch (e) {
    /* abaikan */
  }
  return s;
}

function parseDeviceShow(txt) {
  const res = {};
  let cur = null;
  txt.split('\n').forEach((line) => {
    if (!line) return;
    const p = splitTerse(line);
    const key = p[0].replace(/\[\d+\]$/, '');
    const val = p.slice(1).join(':');
    if (p[0] === 'GENERAL.DEVICE') {
      cur = res[val] = {};
      return;
    }
    if (!cur) return;
    (cur[key] = cur[key] || []).push(val);
  });
  const out = {};
  Object.keys(res).forEach((dev) => {
    const d = res[dev];
    out[dev] = {
      mac: (d['GENERAL.HWADDR'] || [''])[0],
      ip4: (d['IP4.ADDRESS'] || []).filter(Boolean),
      gateway: (d['IP4.GATEWAY'] || [''])[0],
      dns: (d['IP4.DNS'] || []).filter(Boolean),
    };
  });
  return out;
}

async function listConnections() {
  const out = await nmcli(['-t', '-f', 'NAME,UUID,TYPE,DEVICE,AUTOCONNECT', 'connection', 'show']);
  return parseTerse(out, ['name', 'uuid', 'type', 'device', 'autoconnect']).map((c) => ({
    name: c.name,
    uuid: c.uuid,
    type: c.type,
    device: c.device,
    active: !!c.device && c.device !== '--',
    autoconnect: c.autoconnect === 'yes',
  }));
}

/* ---------- handler API ---------- */

async function getStatus() {
  const r = await Promise.all([
    nmcli(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status']),
    nmcli(['-t', '-f', 'WIFI,WWAN', 'radio']),
    listConnections(),
    nmcli(['-t', '-f', 'GENERAL,IP4', 'device', 'show']).catch(() => ''),
    nmcli(['-t', 'networking', 'connectivity']).catch(() => 'unknown'),
  ]);
  const devices = parseTerse(r[0], ['name', 'type', 'state', 'connection']).filter(
    (d) => d.type !== 'loopback' && d.type !== 'wifi-p2p'
  );
  const radio = splitTerse(r[1].trim());
  return {
    time: Date.now(),
    connectivity: r[4].trim(),
    radio: { wifi: radio[0] === 'enabled', wwan: radio[1] === 'enabled' },
    devices,
    details: parseDeviceShow(r[3]),
    connections: r[2],
    traffic: readTraffic(),
    system: readSystem(),
  };
}

async function wifiScan(body, q) {
  const ifname = q.get('ifname') || '';
  if (ifname && !IFNAME_RE.test(ifname)) throw httpError(400, 'ifname tidak valid');
  const base = ['-t', '-f', 'IN-USE,SSID,BSSID,SIGNAL,SECURITY,CHAN,FREQ', 'device', 'wifi', 'list'];
  if (ifname) base.push('ifname', ifname);
  let out;
  try {
    out = await nmcli(base.concat(['--rescan', 'yes']), 30000);
  } catch (e) {
    // scan terlalu cepat / ditolak -> pakai hasil cache
    out = await nmcli(base.concat(['--rescan', 'no']));
  }
  const conns = await listConnections();
  const saved = {};
  conns.forEach((c) => {
    if (c.type === '802-11-wireless') saved[c.name] = true;
  });

  const map = {};
  parseTerse(out, ['inuse', 'ssid', 'bssid', 'signal', 'security', 'chan', 'freq']).forEach((r) => {
    const key = r.ssid || r.bssid;
    const sig = parseInt(r.signal, 10) || 0;
    const ap = {
      ssid: r.ssid,
      bssid: r.bssid,
      signal: sig,
      security: r.security === '--' ? '' : r.security,
      chan: r.chan,
      freq: parseInt(r.freq, 10) || 0,
      inUse: r.inuse === '*',
      saved: !!saved[r.ssid],
    };
    const prev = map[key];
    if (!prev) map[key] = ap;
    else {
      if (ap.inUse) prev.inUse = true;
      if (ap.signal > prev.signal) {
        const inUse = prev.inUse;
        map[key] = ap;
        ap.inUse = inUse || ap.inUse;
      }
    }
  });
  const list = Object.keys(map)
    .map((k) => map[k])
    .sort((a, b) => (b.inUse ? 1 : 0) - (a.inUse ? 1 : 0) || b.signal - a.signal);
  return { aps: list };
}

async function wifiConnect(body) {
  const ssid = need(body, 'ssid', { max: 32 });
  if (Buffer.byteLength(ssid) > 32) throw httpError(400, 'SSID maksimal 32 byte');
  const password = need(body, 'password', { optional: true, min: 8, max: 63, dash: true });
  const ifname = needIf(body);

  const conns = await listConnections();
  const saved = conns.find((c) => c.type === '802-11-wireless' && c.name === ssid);
  if (saved && !password) {
    const args = ['-w', '30', 'connection', 'up', 'uuid', saved.uuid];
    if (ifname) args.push('ifname', ifname);
    await nmcli(args, 45000);
    return { ok: true, message: 'Tersambung ke ' + ssid };
  }
  const args = ['-w', '30', 'device', 'wifi', 'connect', ssid];
  if (password) args.push('password', password);
  if (ifname) args.push('ifname', ifname);
  if (body.hidden === true) args.push('hidden', 'yes');
  const out = await nmcli(args, 45000);
  return { ok: true, message: out.trim() || 'Tersambung ke ' + ssid };
}

async function wifiDisconnect(body) {
  const ifname = needIf(body, false);
  await nmcli(['device', 'disconnect', ifname]);
  return { ok: true };
}

async function setRadio(body) {
  const type = body.type;
  if (type !== 'wifi' && type !== 'wwan') throw httpError(400, 'type harus wifi atau wwan');
  await nmcli(['radio', type, body.enabled ? 'on' : 'off']);
  return { ok: true };
}

async function hotspotStart(body) {
  const ifname = needIf(body, false);
  const ssid = need(body, 'ssid', { max: 32 });
  const password = need(body, 'password', { min: 8, max: 63, dash: true });
  const band = body.band === 'a' ? 'a' : 'bg';
  // Hapus semua profil Hotspot lama (termasuk sisa percobaan gagal)
  for (let i = 0; i < 5; i++) {
    try {
      await nmcli(['connection', 'delete', 'id', HOTSPOT_NAME]);
    } catch (e) {
      break;
    }
  }
  // Dibuat manual (bukan "device wifi hotspot") agar PMF bisa dinonaktifkan sebelum aktivasi.
  // Banyak driver WiFi OpenStick (msm8916/wcnss) gagal dengan PMF default di mode AP
  // dengan error "802.1X supplicant took too long to authenticate".
  await nmcli([
    'connection', 'add', 'type', 'wifi', 'ifname', ifname, 'con-name', HOTSPOT_NAME,
    'autoconnect', 'no',
    'ssid', ssid,
    '802-11-wireless.mode', 'ap',
    '802-11-wireless.band', band,
    'ipv4.method', 'shared',
    'ipv6.method', 'ignore',
    '802-11-wireless-security.key-mgmt', 'wpa-psk',
    '802-11-wireless-security.proto', 'rsn',
    '802-11-wireless-security.pairwise', 'ccmp',
    '802-11-wireless-security.group', 'ccmp',
    '802-11-wireless-security.pmf', '1',
    '802-11-wireless-security.psk', password,
  ]);
  try {
    await nmcli(['-w', '30', 'connection', 'up', 'id', HOTSPOT_NAME, 'ifname', ifname], 45000);
  } catch (e) {
    await nmcli(['connection', 'delete', 'id', HOTSPOT_NAME]).catch(() => null);
    throw e;
  }
  return { ok: true };
}

async function hotspotStop() {
  await nmcli(['connection', 'down', 'id', HOTSPOT_NAME]);
  return { ok: true };
}

async function connAction(action, body) {
  const uuid = needUuid(body);
  if (action === 'up') {
    const args = ['-w', '45', 'connection', 'up', 'uuid', uuid];
    const ifname = needIf(body);
    if (ifname) args.push('ifname', ifname);
    await nmcli(args, 60000);
  } else if (action === 'down') {
    await nmcli(['connection', 'down', 'uuid', uuid]);
  } else if (action === 'delete') {
    await nmcli(['connection', 'delete', 'uuid', uuid]);
  } else if (action === 'autoconnect') {
    await nmcli(['connection', 'modify', 'uuid', uuid, 'connection.autoconnect', body.enabled ? 'yes' : 'no']);
  }
  return { ok: true };
}

/* ---------- 4G / ModemManager ---------- */

async function mmcliJson(args) {
  const out = await run('mmcli', args.concat(['-J']), 15000);
  return JSON.parse(out);
}

async function getModem() {
  try {
    const list = await mmcliJson(['-L']);
    const paths = list['modem-list'] || [];
    if (!paths.length) return null;
    const id = String(paths[0]).split('/').pop();
    const j = await mmcliJson(['-m', id]);
    const m = j.modem || {};
    const g = m.generic || {};
    const t = m['3gpp'] || {};
    const sq = g['signal-quality'] || {};
    return {
      id,
      manufacturer: g.manufacturer || '',
      model: g.model || '',
      state: g.state || '',
      powerState: g['power-state'] || '',
      failedReason: g['state-failed-reason'] || '',
      signal: parseInt(sq.value, 10) || 0,
      tech: g['access-technologies'] || [],
      imei: g['equipment-identifier'] || t.imei || '',
      operator: t['operator-name'] || '',
      operatorCode: t['operator-code'] || '',
      registration: t['registration-state'] || '',
      numbers: g['own-numbers'] || [],
    };
  } catch (e) {
    return null;
  }
}

async function getMobile() {
  const conns = (await listConnections()).filter((c) => c.type === 'gsm');
  const profiles = [];
  for (const c of conns) {
    let apn = '';
    let username = '';
    try {
      const out = await nmcli(['-t', '-f', 'gsm.apn,gsm.username', 'connection', 'show', 'uuid', c.uuid]);
      out.split('\n').filter(Boolean).forEach((l) => {
        const p = splitTerse(l);
        if (p[0] === 'gsm.apn') apn = p.slice(1).join(':');
        if (p[0] === 'gsm.username') username = p.slice(1).join(':');
      });
    } catch (e) {
      /* abaikan */
    }
    profiles.push(Object.assign({}, c, { apn, username }));
  }
  const modem = await getModem();
  return { modem, profiles };
}

async function mobileProfile(body) {
  const name = need(body, 'name', { max: 40 });
  const apn = need(body, 'apn', { max: 64 });
  const username = need(body, 'username', { optional: true, dash: true });
  const password = need(body, 'password', { optional: true, dash: true });
  const pin = need(body, 'pin', { optional: true, max: 8, re: /^[0-9]{4,8}$/ });

  const existing = (await listConnections()).find((c) => c.type === 'gsm' && c.name === name);
  if (existing) {
    const args = ['connection', 'modify', 'uuid', existing.uuid, 'gsm.apn', apn, 'gsm.username', username, 'gsm.password', password];
    if (pin) args.push('gsm.pin', pin);
    await nmcli(args);
  } else {
    const args = ['connection', 'add', 'type', 'gsm', 'ifname', '*', 'con-name', name, 'apn', apn, 'connection.autoconnect', 'yes'];
    if (username) args.push('user', username);
    if (password) args.push('password', password);
    if (pin) args.push('gsm.pin', pin);
    await nmcli(args);
  }
  if (body.connect) {
    await nmcli(['-w', '45', 'connection', 'up', 'id', name], 60000);
  }
  return { ok: true };
}

async function mobileReset() {
  const modem = await getModem();
  if (!modem) throw httpError(404, 'Modem tidak ditemukan (ModemManager/mmcli)');
  await run('mmcli', ['-m', modem.id, '--reset'], 30000);
  return { ok: true };
}

async function systemReboot() {
  setTimeout(() => run('reboot', []).catch(() => null), 500);
  return { ok: true };
}

/* ---------- router & server ---------- */

const routes = {
  'GET /api/status': getStatus,
  'GET /api/wifi/scan': wifiScan,
  'POST /api/wifi/connect': wifiConnect,
  'POST /api/wifi/disconnect': wifiDisconnect,
  'POST /api/radio': setRadio,
  'POST /api/hotspot/start': hotspotStart,
  'POST /api/hotspot/stop': hotspotStop,
  'POST /api/connection/up': (b) => connAction('up', b),
  'POST /api/connection/down': (b) => connAction('down', b),
  'POST /api/connection/delete': (b) => connAction('delete', b),
  'POST /api/connection/autoconnect': (b) => connAction('autoconnect', b),
  'GET /api/mobile': getMobile,
  'POST /api/mobile/profile': mobileProfile,
  'POST /api/mobile/reset': mobileReset,
  'POST /api/system/reboot': systemReboot,
};

function authOk(req) {
  if (!AUTH_PASS) return true;
  const h = req.headers.authorization || '';
  if (h.indexOf('Basic ') !== 0) return false;
  const cred = Buffer.from(h.slice(6), 'base64').toString();
  const a = crypto.createHash('sha256').update(cred).digest();
  const b = crypto.createHash('sha256').update(AUTH_USER + ':' + AUTH_PASS).digest();
  return crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(httpError(413, 'Body terlalu besar'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const j = JSON.parse(Buffer.concat(chunks).toString());
        resolve(j && typeof j === 'object' ? j : {});
      } catch (e) {
        reject(httpError(400, 'JSON tidak valid'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!authOk(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="OpenStick Control Center"' });
      return res.end('Unauthorized');
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.indexOf('/api/') === 0) {
      const route = routes[req.method + ' ' + url.pathname];
      if (!route) throw httpError(404, 'Endpoint tidak ditemukan');
      let body = {};
      if (req.method === 'POST') {
        if (!/^application\/json/i.test(req.headers['content-type'] || '')) {
          throw httpError(415, 'Content-Type harus application/json');
        }
        body = await readBody(req);
      }
      return sendJson(res, 200, await route(body, url.searchParams));
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return fs.readFile(INDEX_FILE, (err, data) => {
        if (err) return sendJson(res, 500, { error: 'index.html tidak ditemukan' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(data);
      });
    }
    throw httpError(404, 'Tidak ditemukan');
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message || 'Terjadi kesalahan' });
  }
});

server.listen(PORT, HOST, () => {
  console.log('OpenStick Control Center berjalan di http://' + HOST + ':' + PORT);
  if (!AUTH_PASS) console.warn('PERINGATAN: AUTH_PASS belum diset, panel tanpa password!');
});
