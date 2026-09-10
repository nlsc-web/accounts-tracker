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
  const body = req.body || {};
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(body, 'client')) patch.client = body.client;
  if (Object.prototype.hasOwnProperty.call(body, 'date')) patch.date = body.date;
  if (Object.prototype.hasOwnProperty.call(body, 'notes')) patch.notes = body.notes;
  if (Object.prototype.hasOwnProperty.call(body, 'staff') && auth.canViewAll(req.user)) {
    patch.staff = body.staff;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });
  const job = await db.updateJob(req.params.id, patch);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
}));

app.post('/api/jobs/:id/stages/:stage/cycle', auth.requireAuth, auth.requireEntry, asyncHandler(async (req, res) => {
  const existing = await db.getJob(req.params.id);
  if (!existing || !auth.ownsJob(req.user, existing)) return res.status(404).json({ error: 'Job not found' });
  const result = await db.cycleStage(req.params.id, req.params.stage, req.user.name);
  if (!result) return res.status(404).json({ error: 'Job not found' });
  res.json(result);
}));

app.post('/api/jobs/:id/extras', auth.requireAuth, auth.requireEntry, asyncHandler(async (req, res) => {
  const existing = await db.getJob(req.params.id);
  if (!existing || !auth.ownsJob(req.user, existing)) return res.status(404).json({ error: 'Job not found' });
  const job = await db.addExtraTask(req.params.id, (req.body || {}).title, req.user.name);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.status(201).json(job);
}));

app.post('/api/jobs/:id/extras/:extraId/cycle', auth.requireAuth, auth.requireEntry, asyncHandler(async (req, res) => {
  const existing = await db.getJob(req.params.id);
  if (!existing || !auth.ownsJob(req.user, existing)) return res.status(404).json({ error: 'Job not found' });
  const result = await db.cycleExtraTask(req.params.id, req.params.extraId, req.user.name);
  if (!result) return res.status(404).json({ error: 'Other work not found' });
  res.json(result);
}));

app.delete('/api/jobs/:id/extras/:extraId', auth.requireAuth, auth.requireEntry, asyncHandler(async (req, res) => {
  const existing = await db.getJob(req.params.id);
  if (!existing || !auth.ownsJob(req.user, existing)) return res.status(404).json({ error: 'Job not found' });
  const job = await db.deleteExtraTask(req.params.id, req.params.extraId);
  if (!job) return res.status(404).json({ error: 'Other work not found' });
  res.json(job);
}));

app.delete('/api/jobs/:id', auth.requireAuth, auth.requireEntry, asyncHandler(async (req, res) => {
  const existing = await db.getJob(req.params.id);
  if (!existing || !auth.ownsJob(req.user, existing)) return res.status(404).json({ error: 'Job not found' });
  const ok = await db.deleteJob(req.params.id, req.user.name);
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

app.delete('/api/time-entries/:id', auth.requireAuth, auth.requireEntry, asyncHandler(async (req, res) => {
  const entry = await db.getTimeEntry(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  if (!auth.canViewAll(req.user) && entry.actor !== req.user.name) {
    return res.status(404).json({ error: 'Entry not found' });
  }
  const ok = await db.deleteTimeEntry(req.params.id, req.user.name);
  if (!ok) return res.status(404).json({ error: 'Entry not found' });
  res.json({ ok: true });
}));

function filterRecycle(user, jobs, timeEntries) {
  if (auth.canViewAll(user)) return { jobs, timeEntries };
  return {
    jobs: jobs.filter((j) => auth.ownsJob(user, j)),
    timeEntries: timeEntries.filter((e) => e.actor === user.name)
  };
}

async function loadRecycle(user) {
  const [jobs, timeEntries] = await Promise.all([
    db.listDeletedJobs(),
    db.listDeletedTimeEntries()
  ]);
  return filterRecycle(user, jobs, timeEntries);
}

app.get('/api/recycle-bin', auth.requireAuth, asyncHandler(async (req, res) => {
  res.json(await loadRecycle(req.user));
}));

app.post('/api/recycle-bin/jobs/:id/restore', auth.requireAuth, auth.requireEntry, asyncHandler(async (req, res) => {
  const existing = await db.getJobAny(req.params.id);
  if (!existing || !existing.deletedAt || !auth.ownsJob(req.user, existing)) {
    return res.status(404).json({ error: 'Item not found' });
  }
  const job = await db.restoreJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Item not found' });
  res.json(job);
}));

app.delete('/api/recycle-bin/jobs/:id', auth.requireAuth, auth.requireEntry, asyncHandler(async (req, res) => {
  const existing = await db.getJobAny(req.params.id);
  if (!existing || !existing.deletedAt || !auth.ownsJob(req.user, existing)) {
    return res.status(404).json({ error: 'Item not found' });
  }
  const ok = await db.purgeJob(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Item not found' });
  res.json({ ok: true });
}));

app.post('/api/recycle-bin/time-entries/:id/restore', auth.requireAuth, auth.requireEntry, asyncHandler(async (req, res) => {
  const existing = await db.getTimeEntryAny(req.params.id);
  if (!existing || !existing.deletedAt) return res.status(404).json({ error: 'Item not found' });
  if (!auth.canViewAll(req.user) && existing.actor !== req.user.name) {
    return res.status(404).json({ error: 'Item not found' });
  }
  const entry = await db.restoreTimeEntry(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Item not found' });
  res.json(entry);
}));

app.delete('/api/recycle-bin/time-entries/:id', auth.requireAuth, auth.requireEntry, asyncHandler(async (req, res) => {
  const existing = await db.getTimeEntryAny(req.params.id);
  if (!existing || !existing.deletedAt) return res.status(404).json({ error: 'Item not found' });
  if (!auth.canViewAll(req.user) && existing.actor !== req.user.name) {
    return res.status(404).json({ error: 'Item not found' });
  }
  const ok = await db.purgeTimeEntry(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Item not found' });
  res.json({ ok: true });
}));

app.post('/api/recycle-bin/empty', auth.requireAuth, auth.requireEntry, asyncHandler(async (req, res) => {
  const bin = await loadRecycle(req.user);
  for (const job of bin.jobs) {
    await db.purgeJob(job.id);
  }
  for (const entry of bin.timeEntries) {
    await db.purgeTimeEntry(entry.id);
  }
  res.json({ ok: true, purged: bin.jobs.length + bin.timeEntries.length });
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
