// MiDrives server: carpool groups and ride reminders.
// Needs Node 18 or newer. Reminders also need `npm install` (the web-push package).
//   PORT=8080 DATA_FILE=./data.json ALLOWED_ORIGIN=https://faisalirshid.github.io node server.js
// Keeps everything in one JSON file. Fine for a few friends; see README.md.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 8080;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const INVITE_DAYS = 7;
const MAX_MEMBERS = 8;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'https://github.com/faisalIrshid/midrives';
const DRY_RUN = process.env.PUSH_DRY_RUN === '1';
let webPushLib = null;
try { webPushLib = require('web-push'); } catch (e) { /* reminders stay off until `npm install` */ }

/* ---------- storage ---------- */
let db = { groups: {}, invites: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { /* first run */ }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
  }, 50);
}

/* ---------- helpers ---------- */
const id = (n = 12) => crypto.randomBytes(n).toString('base64url');
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    let c = '';
    const b = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) c += CODE_CHARS[b[i] % CODE_CHARS.length];
    if (!db.invites[c]) return c;
  }
}
function clean(s, max) { return String(s == null ? '' : s).trim().slice(0, max); }
function money(v) { const n = Math.round(parseFloat(v) * 100) / 100; return n > 0 && n < 1000 ? n : 0; }
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function publicGroup(g) {
  return {
    id: g.id, name: g.name, driverName: g.driverName, prices: g.prices, createdAt: g.createdAt,
    members: Object.values(g.members).filter((m) => !m.left).map((m) => ({ id: m.id, name: m.name, role: m.role, joinedOn: m.joinedOn })),
    rides: g.rides
  };
}
function makeInvite(g, by) {
  // drop this group's expired codes
  for (const [c, inv] of Object.entries(db.invites)) if (inv.groupId === g.id && inv.expiresAt < Date.now()) delete db.invites[c];
  const code = newCode();
  const inv = { code, groupId: g.id, by, expiresAt: Date.now() + INVITE_DAYS * 864e5 };
  db.invites[code] = inv;
  return { code, expiresAt: new Date(inv.expiresAt).toISOString() };
}
function addMember(g, name, role) {
  const token = id(24);
  const m = { id: id(6), name: clean(name, 40) || 'Rider', role, tokenHash: hash(token), joinedOn: today() };
  g.members[m.id] = m;
  return { id: m.id, token };
}
function auth(req, g) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const h = hash(t);
  const m = t && Object.values(g.members).find((x) => !x.left && x.tokenHash === h);
  if (!m) throw new HttpError(401, 'Not a member of this carpool');
  return m;
}
function group(gid) {
  const g = db.groups[gid];
  if (!g) throw new HttpError(404, 'Carpool not found');
  return g;
}


/* ---------- reminders (web push) ---------- */
function vapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  if (!db.vapid) { if (!webPushLib) throw new HttpError(501, 'Reminders need the web-push package. Run npm install in the server folder.'); db.vapid = webPushLib.generateVAPIDKeys(); save(); }
  return db.vapid;
}
function pushClient() {
  if (!webPushLib) throw new HttpError(501, 'Reminders need the web-push package. Run npm install in the server folder.');
  const v = vapid();
  webPushLib.setVapidDetails(VAPID_SUBJECT, v.publicKey, v.privateKey);
  return webPushLib;
}
function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; } }
function applyPushSettings(s, b) {
  if (b.schedule) {
    const sc = b.schedule, okT = (v) => Number.isInteger(v) && v >= 0 && v < 1440;
    s.schedule = {
      m: okT(sc.m) ? sc.m : 420, e: okT(sc.e) ? sc.e : 960,
      days: Array.isArray(sc.days) ? [...new Set(sc.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : [1, 2, 3, 4, 5],
      tz: typeof sc.tz === 'string' && validTz(sc.tz) ? sc.tz : 'UTC'
    };
  }
  if (b.driverName != null) s.driverName = clean(b.driverName, 40);
  if (b.carpool !== undefined) s.carpool = b.carpool && b.carpool.groupId ? { groupId: clean(b.carpool.groupId, 40), memberId: clean(b.carpool.memberId, 40) } : null;
  if (b.answered && /^\d{4}-\d{2}-\d{2}$/.test(String(b.answered.date))) {
    const a = s.answered[b.answered.date] || (s.answered[b.answered.date] = {});
    for (const leg of ['m', 'e']) if (b.answered[leg] != null) a[leg] = !!b.answered[leg];
  }
}
function localNow(tz, when) {
  const o = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(when || new Date())) o[x.type] = x.value;
  return { date: `${o.year}-${o.month}-${o.day}`, mins: (+o.hour % 24) * 60 + +o.minute, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) };
}
function answeredLeg(s, date, leg) {
  if (s.answered[date] && s.answered[date][leg]) return true;
  if (s.carpool) {
    const g = db.groups[s.carpool.groupId];
    if (g && g.rides[date] && g.rides[date][leg === 'm' ? 'w' : 'h']) return true;
  }
  return false;
}
async function tick(when) {
  if (!db.push) return;
  let wp = null;
  if (!DRY_RUN) { try { wp = pushClient(); } catch (e) { return; } }
  for (const s of Object.values(db.push.subs)) {
    if (!s.schedule) continue;
    const now = localNow(s.schedule.tz, when);
    for (const k of Object.keys(s.sent)) if (k.slice(0, 10) < now.date) delete s.sent[k];
    for (const k of Object.keys(s.answered)) if (k < now.date) delete s.answered[k];
    if (s.schedule.days.indexOf(now.wd) < 0) continue;
    for (const leg of ['m', 'e']) {
      const at = s.schedule[leg], key = now.date + ':' + leg;
      // send at the minute, or up to 15 minutes late if the server was busy or restarting
      if (now.mins < at || now.mins > at + 15 || s.sent[key] || answeredLeg(s, now.date, leg)) continue;
      s.sent[key] = true; save();
      const driver = s.driverName || 'your driver';
      const payload = { title: leg === 'm' ? 'Ride to Work' : 'Ride Home', body: leg === 'm' ? `Riding with ${driver} this morning?` : `Riding home with ${driver} this evening?`, leg, date: now.date };
      if (DRY_RUN) { console.log('DRY RUN push to', s.id, JSON.stringify(payload)); continue; }
      try { await wp.sendNotification(s.subscription, JSON.stringify(payload), { TTL: 3600, urgency: 'high' }); }
      catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { delete db.push.subs[s.id]; save(); }
        else console.error('Push failed:', e.statusCode || e.message);
      }
    }
  }
}

/* ---------- routes ---------- */
async function route(req, url, body) {
  const p = url.pathname.replace(/\/+$/, '');
  const parts = p.split('/').filter(Boolean);

  if (req.method === 'GET' && (p === '' || p === '/health')) return { ok: true, app: 'midrives', api: 1, reminders: !!webPushLib };

  // Reminders: the app's public key for subscribing
  if (req.method === 'GET' && p === '/push/key') return { publicKey: vapid().publicKey };

  // Reminders: { subscription, schedule: { m, e, days, tz }, driverName, carpool }
  if (req.method === 'POST' && p === '/push/subscribe') {
    const sub = body.subscription;
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) throw new HttpError(400, 'Bad subscription');
    db.push = db.push || { subs: {} };
    let s = Object.values(db.push.subs).find((x) => x.subscription.endpoint === sub.endpoint);
    if (!s) { s = { id: id(8), answered: {}, sent: {} }; db.push.subs[s.id] = s; }
    const token = id(24);
    s.tokenHash = hash(token);
    s.subscription = { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } };
    applyPushSettings(s, Object.assign({ schedule: {} }, body));
    save();
    return { status: 201, body: { id: s.id, token } };
  }
  if (parts[0] === 'push' && parts[1] && parts.length === 2) {
    const s = db.push && db.push.subs[parts[1]];
    if (!s) throw new HttpError(404, 'Reminders not found');
    const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!t || hash(t) !== s.tokenHash) throw new HttpError(401, 'Not allowed');
    if (req.method === 'PUT') { applyPushSettings(s, body); save(); return { ok: true }; }
    if (req.method === 'DELETE') { delete db.push.subs[s.id]; save(); return { status: 204 }; }
  }

  // Start a carpool: { name, driverName, price, memberName }
  if (req.method === 'POST' && p === '/groups') {
    const g = { id: id(9), name: clean(body.name, 60) || 'Carpool', driverName: clean(body.driverName, 40), prices: [], createdAt: new Date().toISOString(), members: {}, rides: {} };
    const pr = money(body.price);
    if (pr) g.prices.push({ from: today(), rate: pr });
    const me = addMember(g, body.memberName, 'organizer');
    db.groups[g.id] = g;
    const invite = makeInvite(g, me.id);
    save();
    return { status: 201, body: { group: publicGroup(g), me, invite } };
  }

  // Join with a code: { code, memberName }
  if (req.method === 'POST' && p === '/join') {
    const code = clean(body.code, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const inv = db.invites[code];
    if (!inv || inv.expiresAt < Date.now()) throw new HttpError(404, 'That code is wrong or has expired');
    const g = group(inv.groupId);
    if (Object.values(g.members).filter((m) => !m.left).length >= MAX_MEMBERS) throw new HttpError(409, 'This carpool is full');
    const me = addMember(g, body.memberName, 'member');
    save();
    return { group: publicGroup(g), me: { id: me.id, token: me.token } };
  }

  if (parts[0] === 'groups' && parts[1]) {
    const g = group(parts[1]);
    const me = auth(req, g);

    // Everything about the carpool
    if (req.method === 'GET' && parts.length === 2) return { group: publicGroup(g), me: { id: me.id } };

    // Organizer: rename or change the price { name?, price? }
    if (req.method === 'PATCH' && parts.length === 2) {
      if (me.role !== 'organizer') throw new HttpError(403, 'Only the organizer can change this');
      if (body.name != null) g.name = clean(body.name, 60) || g.name;
      if (body.driverName != null) g.driverName = clean(body.driverName, 40);
      if (body.price != null) {
        const pr = money(body.price), t = today();
        g.prices = g.prices.filter((x) => x.from !== t);
        if (pr) g.prices.push({ from: t, rate: pr });
      }
      save();
      return { group: publicGroup(g) };
    }

    // New invite code
    if (req.method === 'POST' && parts[2] === 'invites') { const invite = makeInvite(g, me.id); save(); return { status: 201, body: { invite } }; }

    // Log a ride: { date: 'YYYY-MM-DD', leg: 'w'|'h', riders: [memberId] | null }   null removes it
    if (req.method === 'PUT' && parts[2] === 'rides') {
      const date = String(body.date || ''), leg = body.leg;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (leg !== 'w' && leg !== 'h')) throw new HttpError(400, 'Bad date or leg');
      const day = g.rides[date] || (g.rides[date] = {});
      if (body.riders == null) delete day[leg];
      else {
        if (!Array.isArray(body.riders)) throw new HttpError(400, 'riders must be a list');
        const ok = new Set(Object.values(g.members).filter((m) => !m.left).map((m) => m.id));
        const riders = [...new Set(body.riders)].filter((r) => ok.has(r));
        day[leg] = { riders, by: me.id, at: new Date().toISOString() };
      }
      if (!Object.keys(day).length) delete g.rides[date];
      save();
      return { ride: g.rides[date] ? g.rides[date][leg] || null : null };
    }

    // Leave (yourself) or remove someone (organizer)
    if (req.method === 'DELETE' && parts[2] === 'members' && parts[3]) {
      const target = g.members[parts[3]];
      if (!target || target.left) throw new HttpError(404, 'Member not found');
      if (target.id !== me.id && me.role !== 'organizer') throw new HttpError(403, 'Only the organizer can remove people');
      target.left = true; target.tokenHash = null;
      const rest = Object.values(g.members).filter((m) => !m.left);
      if (!rest.length) { for (const [c, inv] of Object.entries(db.invites)) if (inv.groupId === g.id) delete db.invites[c]; delete db.groups[g.id]; }
      else if (target.role === 'organizer') { target.role = 'member'; rest.sort((a, b) => a.joinedOn.localeCompare(b.joinedOn))[0].role = 'organizer'; }
      save();
      return { status: 204 };
    }
  }
  throw new HttpError(404, 'Not found');
}

/* ---------- http ---------- */
http.createServer((req, res) => {
  const origin = ALLOWED_ORIGIN === '*' ? '*' : ALLOWED_ORIGIN;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 64 * 1024) req.destroy(); });
  req.on('end', async () => {
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    try {
      const body = raw ? JSON.parse(raw) : {};
      const out = await route(req, new URL(req.url, 'http://x'), body);
      if (out && out.status) send(out.status, out.body);
      else send(200, out);
    } catch (e) {
      if (e instanceof SyntaxError) return send(400, { error: 'Bad JSON' });
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error(e);
      send(500, { error: 'Server error' });
    }
  });
}).listen(PORT, () => console.log(`MiDrives server on :${PORT}, data in ${DATA_FILE}, reminders ${webPushLib ? (DRY_RUN ? 'dry run' : 'on') : 'off (run npm install)'}`));

setInterval(() => tick().catch((e) => console.error(e)), 30 * 1000);
module.exports = { tick, localNow };
