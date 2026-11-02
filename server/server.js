// MiDrives carpool server.
// One file, no dependencies. Needs Node 18 or newer.
//   PORT=8080 DATA_FILE=./data.json ALLOWED_ORIGIN=https://faisalirshid.github.io node server.js
// Keeps every group in one JSON file. Fine for a few friends; see README.md.
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

/* ---------- routes ---------- */
async function route(req, url, body) {
  const p = url.pathname.replace(/\/+$/, '');
  const parts = p.split('/').filter(Boolean);

  if (req.method === 'GET' && (p === '' || p === '/health')) return { ok: true, app: 'midrives', api: 1 };

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
}).listen(PORT, () => console.log(`MiDrives carpool server on :${PORT}, data in ${DATA_FILE}`));
