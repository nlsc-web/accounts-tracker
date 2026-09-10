const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const COOKIE = 'adt_sid';
const SESSION_DAYS = 7;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

const USERS = [
  { name: 'Mrs.Lakmali', role: 'viewer', viewAll: true, pinHash: '$2b$10$ABtZ80B6sE.m8Xd9Kzpx7eBJuTW5bOXT3WIdPzyMZGGEta7X3dTIe' },
  { name: 'Ms.Sajini', role: 'entry', viewAll: true, pinHash: '$2b$10$wGEuBKhqgRyz7s.SKwxYw.Xgj4WbFreJoLpISO1TN1pqllJtWykoe' },
  { name: 'Mr.Denuwan', role: 'entry', viewAll: true, pinHash: '$2b$10$/c3ZuYPq8VFMVAzF3QquSeyPQsoR0UBCLnhjI2u0biL8roJ8BMVta' },
  { name: 'Dilan', role: 'entry', pinHash: '$2b$10$RcN4hgkY8R5Hj4TA0pSjh.vArtqBesL0Yg7NN6lbXq1eZ3AhNyEze' },
  { name: 'Dilini', role: 'entry', pinHash: '$2b$10$D11DX7hhKX8oIyzIx.sFyeoZ4VyC1TRZsbW.kRL7xViIXJMaZ3emW' },
  { name: 'Malik', role: 'entry', pinHash: '$2b$10$CBci.jqzbommYq2c1zgFuuWvhfZDbq/tX3lrI.LNbHJrgXu/CzxtC' },
  { name: 'Asjath', role: 'entry', pinHash: '$2b$10$fh2McsFabovEeLbta7yOAe5HS2nMcgr3XHLGAgRk/oM.81Z/uKXj.' }
];

const loginFails = new Map();

function isProd() {
  return Boolean(process.env.RENDER || process.env.NODE_ENV === 'production');
}

function loadSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) {
    return process.env.SESSION_SECRET;
  }
  const dir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.session-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { encoding: 'utf8' });
  if (isProd()) {
    console.warn('SESSION_SECRET is not set. Sessions will reset on each deploy. Add SESSION_SECRET in Render Environment.');
  }
  return secret;
}

const SECRET = loadSecret();

function publicUsers() {
  return USERS.map((u) => ({ name: u.name, role: u.role, viewAll: Boolean(u.viewAll) }));
}

function toPublicUser(user) {
  if (!user) return null;
  return { name: user.name, role: user.role, viewAll: Boolean(user.viewAll) };
}

function canViewAll(user) {
  return Boolean(user && user.viewAll);
}

function ownsRecord(user, staffName, actorName) {
  if (canViewAll(user)) return true;
  const name = user && user.name;
  if (!name) return false;
  return staffName === name || actorName === name;
}

function ownsJob(user, job) {
  if (!job) return false;
  return ownsRecord(user, String(job.staff || '').trim(), '');
}

function findUser(name) {
  return USERS.find((u) => u.name === name) || null;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 1) return;
    const key = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  });
  return out;
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || payload.exp < Date.now()) return null;
    const user = findUser(payload.n);
    if (!user) return null;
    return toPublicUser(user);
  } catch {
    return null;
  }
}

function cookieHeader(token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  if (isProd()) parts.push('Secure');
  return parts.join('; ');
}

function clearCookieHeader() {
  const parts = [`${COOKIE}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (isProd()) parts.push('Secure');
  return parts.join('; ');
}

function clientKey(req, name) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || req.socket.remoteAddress || '';
  return `${ip}|${String(name || '').toLowerCase()}`;
}

function tooManyFails(req, name) {
  const rec = loginFails.get(clientKey(req, name));
  if (!rec) return false;
  if (Date.now() - rec.t > FAIL_WINDOW_MS) {
    loginFails.delete(clientKey(req, name));
    return false;
  }
  return rec.n >= MAX_FAILS;
}

function recordFail(req, name) {
  const key = clientKey(req, name);
  const rec = loginFails.get(key);
  if (!rec || Date.now() - rec.t > FAIL_WINDOW_MS) {
    loginFails.set(key, { n: 1, t: Date.now() });
    return;
  }
  rec.n += 1;
}

function clearFails(req, name) {
  loginFails.delete(clientKey(req, name));
}

async function login(name, pin) {
  const user = findUser(name);
  const dummy = '$2b$10$C6UzMDMMhYgDkwrQPB8n8eJ5xN0QKqH8qKqH8qKqH8qKqH8qKqHe';
  const hash = user ? user.pinHash : dummy;
  let ok = false;
  try {
    ok = await bcrypt.compare(String(pin || ''), hash);
  } catch {
    ok = false;
  }
  if (!user || !ok) return null;
  return toPublicUser(user);
}

function createSession(user) {
  return sign({
    n: user.name,
    exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
  });
}

function readSession(req) {
  return verifyToken(parseCookies(req)[COOKIE]);
}

function requireAuth(req, res, next) {
  const user = readSession(req);
  if (!user) return res.status(401).json({ error: 'Login required' });
  req.user = user;
  next();
}

function requireEntry(req, res, next) {
  if (!req.user || req.user.role !== 'entry') {
    return res.status(403).json({ error: 'View-only accounts cannot change the ledger' });
  }
  next();
}

module.exports = {
  publicUsers,
  canViewAll,
  ownsJob,
  ownsRecord,
  login,
  createSession,
  readSession,
  cookieHeader,
  clearCookieHeader,
  tooManyFails,
  recordFail,
  clearFails,
  requireAuth,
  requireEntry
};
