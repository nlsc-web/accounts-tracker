const express = require('express');
const path = require('path');
const db = require('./db');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 5600;
const STATIC_DIR = path.join(__dirname, 'accounts department');

app.use(express.json({ limit: '32kb' }));
app.use(express.static(STATIC_DIR, {
  setHeaders(res, filePath) {
    if (/\.(html|js|css|webmanifest)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

app.get('/api/health', asyncHandler(async (req, res) => {
  const dbHealth = await db.health();
  res.json({ ok: true, time: new Date().toISOString(), db: dbHealth });
}));

app.get('/api/users', (req, res) => {
  res.json(auth.publicUsers());
});

app.get('/api/me', (req, res) => {
  const user = auth.readSession(req);
  if (!user) return res.status(401).json({ error: 'Login required' });
  res.json(user);
});

app.post('/api/login', asyncHandler(async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  const pin = String((req.body || {}).pin || '');
  if (!name || !pin) {
    return res.status(400).json({ error: 'Name and PIN are required' });
  }
  if (auth.tooManyFails(req, name)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }
  const user = await auth.login(name, pin);
  if (!user) {
    auth.recordFail(req, name);
    return res.status(401).json({ error: 'Wrong PIN. Try again.' });
  }
  auth.clearFails(req, name);
  res.setHeader('Set-Cookie', auth.cookieHeader(auth.createSession(user)));
  res.json(user);
}));

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', auth.clearCookieHeader());
  res.json({ ok: true });
});

app.get('/api/stages', auth.requireAuth, (req, res) => {
  res.json(db.STAGES);
});

app.get('/api/jobs', auth.requireAuth, asyncHandler(async (req, res) => {
  const jobs = await db.listJobs();
  if (auth.canViewAll(req.user)) return res.json(jobs);
  res.json(jobs.filter((j) => auth.ownsJob(req.user, j)));
}));

app.get('/api/jobs/:id', auth.requireAuth, asyncHandler(async (req, res) => {
  const job = await db.getJob(req.params.id);
  if (!job || !auth.ownsJob(req.user, job)) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
}));

app.post('/api/jobs', auth.requireAuth, auth.requireEntry, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const client = String(body.client || '').trim();
  if (!client) return res.status(400).json({ error: 'Client name is required' });
  const staff = auth.canViewAll(req.user)
    ? String(body.staff || '').trim()
    : req.user.name;
  res.status(201).json(await db.createJob({
    client,
    staff,
    date: body.date
  }));
}));

app.patch('/api/jobs/:id', auth.requireAuth, auth.requireEntry, asyncHandler(async (req, res) => {
  const existing = await db.getJob(req.params.id);
  if (!existing || !auth.ownsJob(req.user, existing)) return res.status(404).json({ error: 'Job not found' });
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'notes')) {
    const job = await db.updateNotes(req.params.id, req.body.notes);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    return res.json(job);
  }
  return res.status(400).json({ error: 'Nothing to update' });
}));

app.post('/api/jobs/:id/stages/:stage/cycle', auth.requireAuth, auth.requireEntry, asyncHandler(async (req, res) => {
  const existing = await db.getJob(req.params.id);
  if (!existing || !auth.ownsJob(req.user, existing)) return res.status(404).json({ error: 'Job not found' });
  const result = await db.cycleStage(req.params.id, req.params.stage, req.user.name);
  if (!result) return res.status(404).json({ error: 'Job not found' });
  res.json(result);
}));

app.delete('/api/jobs/:id', auth.requireAuth, auth.requireEntry, asyncHandler(async (req, res) => {
  const existing = await db.getJob(req.params.id);
  if (!existing || !auth.ownsJob(req.user, existing)) return res.status(404).json({ error: 'Job not found' });
  const ok = await db.deleteJob(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Job not found' });
  res.json({ ok: true });
}));

app.get('/api/activity', auth.requireAuth, asyncHandler(async (req, res) => {
  if (!auth.canViewAll(req.user)) return res.json([]);
  res.json(await db.listActivity(req.query.date));
}));

app.get('/api/time-entries', auth.requireAuth, asyncHandler(async (req, res) => {
  const entries = await db.listTimeEntries(req.query.date);
  if (auth.canViewAll(req.user)) return res.json(entries);
  res.json(entries.filter((e) => e.actor === req.user.name));
}));

app.post('/api/timer/start', auth.requireAuth, auth.requireEntry, asyncHandler(async (req, res) => {
  const body = req.body || {};
  let client = String(body.client || '').trim();
  let jobId = String(body.jobId || '').trim();
  if (jobId) {
    const job = await db.getJob(jobId);
    if (!job || !auth.ownsJob(req.user, job)) {
      return res.status(404).json({ error: 'Job not found' });
    }
    client = job.client;
  }
  const entry = await db.startTimer({
    actor: req.user.name,
    jobId,
    client,
    note: body.note
  });
  res.status(201).json(entry);
}));

app.post('/api/timer/stop', auth.requireAuth, auth.requireEntry, asyncHandler(async (req, res) => {
  const entry = await db.stopTimer(req.user.name);
  if (!entry) return res.status(400).json({ error: 'No timer is running' });
  res.json(entry);
}));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: status === 500 ? 'Server error' : err.message });
});

async function start() {
  await db.ready();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Accounts tracker running at http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
