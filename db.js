const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL || '';

const STAGES = [
  { key: 'bank', label: 'Bank Statement Entry' },
  { key: 'invoices', label: 'Invoice Entry' },
  { key: 'receipts', label: 'Receipt Entry' },
  { key: 'voucher', label: 'Payment Voucher Entry' },
  { key: 'other', label: 'Other Documents Entry' },
  { key: 'finstmt', label: 'Financial Statements & Tax Working' },
  { key: 'audit', label: 'Audit Report & Management Letter' },
  { key: 'ramis', label: 'RAMIS Submission' },
  { key: 'clientscan', label: 'Client Document Scanning' }
];

const CYCLE = ['pending', 'progress', 'done'];
const STAGE_KEYS = STAGES.map((s) => s.key);

const CREATE_JOBS_SQL = `
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    client TEXT NOT NULL,
    staff TEXT DEFAULT '',
    date TEXT NOT NULL,
    stages TEXT NOT NULL,
    notes TEXT DEFAULT '',
    "createdAt" TEXT,
    "updatedAt" TEXT
  )
`;

const CREATE_LOG_SQL = `
  CREATE TABLE IF NOT EXISTS activity_log (
    id TEXT PRIMARY KEY,
    "jobId" TEXT,
    client TEXT,
    staff TEXT,
    actor TEXT,
    stage TEXT,
    status TEXT,
    date TEXT,
    ts BIGINT,
    "durationMs" BIGINT
  )
`;

const CREATE_TIME_SQL = `
  CREATE TABLE IF NOT EXISTS time_entries (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    "jobId" TEXT DEFAULT '',
    client TEXT DEFAULT '',
    note TEXT DEFAULT '',
    "startTs" BIGINT NOT NULL,
    "endTs" BIGINT,
    date TEXT NOT NULL
  )
`;

function emptyStages() {
  const stages = {};
  STAGE_KEYS.forEach((key) => {
    stages[key] = 'pending';
  });
  return stages;
}

function parseStages(raw) {
  let parsed = {};
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) || {};
    } catch {
      parsed = {};
    }
  } else if (raw && typeof raw === 'object') {
    parsed = raw;
  }
  const stages = emptyStages();
  STAGE_KEYS.forEach((key) => {
    if (CYCLE.includes(parsed[key])) stages[key] = parsed[key];
  });
  return stages;
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    client: row.client || '',
    staff: row.staff || '',
    date: row.date || '',
    stages: parseStages(row.stages),
    notes: row.notes || '',
    createdAt: row.createdAt || '',
    updatedAt: row.updatedAt || ''
  };
}

function parseDurationMs(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function durationMsForDone(progressTs, nowTs) {
  if (!progressTs) return null;
  const d = nowTs - Number(progressTs);
  return d > 0 ? d : null;
}

function rowToTimeEntry(row) {
  if (!row) return null;
  const startTs = Number(row.startTs) || 0;
  const endRaw = row.endTs;
  const endTs = endRaw == null || endRaw === '' ? null : Number(endRaw);
  const running = endTs == null || !Number.isFinite(endTs);
  const durationMs = running ? Math.max(0, Date.now() - startTs) : Math.max(0, endTs - startTs);
  return {
    id: row.id,
    actor: row.actor || '',
    jobId: row.jobId || '',
    client: row.client || '',
    note: row.note || '',
    startTs,
    endTs: running ? null : endTs,
    date: row.date || '',
    running,
    durationMs
  };
}

function rowToLog(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.jobId || '',
    client: row.client || '',
    staff: row.staff || '',
    actor: row.actor || '',
    stage: row.stage || '',
    status: row.status || '',
    date: row.date || '',
    ts: Number(row.ts) || 0,
    durationMs: parseDurationMs(row.durationMs)
  };
}

function normalizeJob(job) {
  return {
    id: job.id,
    client: String(job.client || '').trim(),
    staff: String(job.staff || '').trim(),
    date: job.date || '',
    stages: parseStages(job.stages),
    notes: String(job.notes || ''),
    createdAt: job.createdAt || new Date().toISOString(),
    updatedAt: job.updatedAt || new Date().toISOString()
  };
}

function newId(prefix) {
  return prefix + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

function todayISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' });
}

function createSqliteStore() {
  const { DatabaseSync } = require('node:sqlite');
  const DATA_DIR = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, 'data');
  const DB_FILE = path.join(DATA_DIR, 'tracker.db');

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`SQLite database: ${DB_FILE}`);

  const db = new DatabaseSync(DB_FILE);
  db.exec(CREATE_JOBS_SQL.replace(/"createdAt"/g, 'createdAt').replace(/"updatedAt"/g, 'updatedAt'));
  db.exec(CREATE_LOG_SQL.replace(/"jobId"/g, 'jobId').replace(/"durationMs"/g, 'durationMs'));
  db.exec(
    CREATE_TIME_SQL
      .replace(/"jobId"/g, 'jobId')
      .replace(/"startTs"/g, 'startTs')
      .replace(/"endTs"/g, 'endTs')
  );
  const logCols = db.prepare('PRAGMA table_info(activity_log)').all();
  if (!logCols.some((c) => c.name === 'durationMs')) {
    db.exec('ALTER TABLE activity_log ADD COLUMN durationMs INTEGER');
  }

  return {
    async listJobs() {
      return db
        .prepare('SELECT * FROM jobs ORDER BY updatedAt DESC, date DESC')
        .all()
        .map(rowToJob);
    },
    async getJob(id) {
      return rowToJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
    },
    async createJob(body) {
      const now = new Date().toISOString();
      const job = normalizeJob({
        id: newId('job_'),
        client: body.client,
        staff: body.staff,
        date: body.date || todayISO(),
        stages: emptyStages(),
        notes: '',
        createdAt: now,
        updatedAt: now
      });
      db.prepare(`
        INSERT INTO jobs (id, client, staff, date, stages, notes, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        job.id, job.client, job.staff, job.date,
        JSON.stringify(job.stages), job.notes, job.createdAt, job.updatedAt
      );
      return this.getJob(job.id);
    },
    async updateNotes(id, notes) {
      const prev = await this.getJob(id);
      if (!prev) return null;
      const now = new Date().toISOString();
      db.prepare('UPDATE jobs SET notes = ?, updatedAt = ? WHERE id = ?').run(String(notes || ''), now, id);
      return this.getJob(id);
    },
    async cycleStage(id, stageKey, actor) {
      const prev = await this.getJob(id);
      if (!prev) return null;
      if (!STAGE_KEYS.includes(stageKey)) {
        const err = new Error('Unknown stage');
        err.status = 400;
        throw err;
      }
      const cur = prev.stages[stageKey];
      const next = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length];
      prev.stages[stageKey] = next;
      const now = new Date().toISOString();
      db.prepare('UPDATE jobs SET stages = ?, updatedAt = ? WHERE id = ?')
        .run(JSON.stringify(prev.stages), now, id);

      const ts = Date.now();
      let durationMs = null;
      if (next === 'done') {
        const start = db.prepare(
          `SELECT ts FROM activity_log WHERE jobId = ? AND stage = ? AND status = 'progress' ORDER BY ts DESC LIMIT 1`
        ).get(prev.id, stageKey);
        durationMs = durationMsForDone(start && start.ts, ts);
      }
      const log = {
        id: newId('log_'),
        jobId: prev.id,
        client: prev.client,
        staff: prev.staff,
        actor: actor || '',
        stage: stageKey,
        status: next,
        date: todayISO(),
        ts,
        durationMs
      };
      db.prepare(`
        INSERT INTO activity_log (id, jobId, client, staff, actor, stage, status, date, ts, durationMs)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(log.id, log.jobId, log.client, log.staff, log.actor, log.stage, log.status, log.date, log.ts, log.durationMs);

      return { job: await this.getJob(id), log };
    },
    async deleteJob(id) {
      return db.prepare('DELETE FROM jobs WHERE id = ?').run(id).changes > 0;
    },
    async listActivity(date) {
      if (date) {
        return db
          .prepare('SELECT * FROM activity_log WHERE date = ? ORDER BY ts DESC')
          .all(date)
          .map(rowToLog);
      }
      return db
        .prepare('SELECT * FROM activity_log ORDER BY ts DESC LIMIT 200')
        .all()
        .map(rowToLog);
    },
    async listTimeEntries(date) {
      if (date) {
        return db
          .prepare(
            `SELECT * FROM time_entries WHERE date = ? OR endTs IS NULL ORDER BY startTs DESC`
          )
          .all(date)
          .map(rowToTimeEntry);
      }
      return db
        .prepare('SELECT * FROM time_entries ORDER BY startTs DESC LIMIT 200')
        .all()
        .map(rowToTimeEntry);
    },
    async getRunningTimer(actor) {
      return rowToTimeEntry(
        db.prepare('SELECT * FROM time_entries WHERE actor = ? AND endTs IS NULL ORDER BY startTs DESC LIMIT 1').get(actor)
      );
    },
    async startTimer({ actor, jobId, client, note }) {
      const ts = Date.now();
      db.prepare('UPDATE time_entries SET endTs = ? WHERE actor = ? AND endTs IS NULL').run(ts, actor);
      const entry = {
        id: newId('tm_'),
        actor: actor || '',
        jobId: jobId || '',
        client: client || '',
        note: String(note || '').trim().slice(0, 200),
        startTs: ts,
        endTs: null,
        date: todayISO()
      };
      db.prepare(`
        INSERT INTO time_entries (id, actor, jobId, client, note, startTs, endTs, date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(entry.id, entry.actor, entry.jobId, entry.client, entry.note, entry.startTs, entry.endTs, entry.date);
      return rowToTimeEntry(entry);
    },
    async stopTimer(actor) {
      const ts = Date.now();
      const prev = db.prepare('SELECT * FROM time_entries WHERE actor = ? AND endTs IS NULL ORDER BY startTs DESC LIMIT 1').get(actor);
      if (!prev) return null;
      db.prepare('UPDATE time_entries SET endTs = ? WHERE id = ?').run(ts, prev.id);
      return rowToTimeEntry({ ...prev, endTs: ts });
    },
    async health() {
      return { driver: 'sqlite', file: DB_FILE };
    }
  };
}

async function createPostgresStore(connectionString) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false }
  });

  console.log('Postgres database: DATABASE_URL');
  await pool.query(CREATE_JOBS_SQL);
  await pool.query(CREATE_LOG_SQL);
  await pool.query(CREATE_TIME_SQL);
  await pool.query('ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS "durationMs" BIGINT');

  return {
    async listJobs() {
      const res = await pool.query('SELECT * FROM jobs ORDER BY "updatedAt" DESC, date DESC');
      return res.rows.map(rowToJob);
    },
    async getJob(id) {
      const res = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
      return rowToJob(res.rows[0]);
    },
    async createJob(body) {
      const now = new Date().toISOString();
      const job = normalizeJob({
        id: newId('job_'),
        client: body.client,
        staff: body.staff,
        date: body.date || todayISO(),
        stages: emptyStages(),
        notes: '',
        createdAt: now,
        updatedAt: now
      });
      await pool.query(
        `INSERT INTO jobs (id, client, staff, date, stages, notes, "createdAt", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          job.id, job.client, job.staff, job.date,
          JSON.stringify(job.stages), job.notes, job.createdAt, job.updatedAt
        ]
      );
      return this.getJob(job.id);
    },
    async updateNotes(id, notes) {
      const prev = await this.getJob(id);
      if (!prev) return null;
      const now = new Date().toISOString();
      await pool.query('UPDATE jobs SET notes = $1, "updatedAt" = $2 WHERE id = $3', [String(notes || ''), now, id]);
      return this.getJob(id);
    },
    async cycleStage(id, stageKey, actor) {
      const prev = await this.getJob(id);
      if (!prev) return null;
      if (!STAGE_KEYS.includes(stageKey)) {
        const err = new Error('Unknown stage');
        err.status = 400;
        throw err;
      }
      const cur = prev.stages[stageKey];
      const next = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length];
      prev.stages[stageKey] = next;
      const now = new Date().toISOString();
      await pool.query(
        'UPDATE jobs SET stages = $1, "updatedAt" = $2 WHERE id = $3',
        [JSON.stringify(prev.stages), now, id]
      );

      const ts = Date.now();
      let durationMs = null;
      if (next === 'done') {
        const start = await pool.query(
          `SELECT ts FROM activity_log WHERE "jobId" = $1 AND stage = $2 AND status = 'progress' ORDER BY ts DESC LIMIT 1`,
          [prev.id, stageKey]
        );
        durationMs = durationMsForDone(start.rows[0] && start.rows[0].ts, ts);
      }
      const log = {
        id: newId('log_'),
        jobId: prev.id,
        client: prev.client,
        staff: prev.staff,
        actor: actor || '',
        stage: stageKey,
        status: next,
        date: todayISO(),
        ts,
        durationMs
      };
      await pool.query(
        `INSERT INTO activity_log (id, "jobId", client, staff, actor, stage, status, date, ts, "durationMs")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [log.id, log.jobId, log.client, log.staff, log.actor, log.stage, log.status, log.date, log.ts, log.durationMs]
      );
      return { job: await this.getJob(id), log };
    },
    async deleteJob(id) {
      const res = await pool.query('DELETE FROM jobs WHERE id = $1', [id]);
      return res.rowCount > 0;
    },
    async listActivity(date) {
      if (date) {
        const res = await pool.query(
          'SELECT * FROM activity_log WHERE date = $1 ORDER BY ts DESC',
          [date]
        );
        return res.rows.map(rowToLog);
      }
      const res = await pool.query('SELECT * FROM activity_log ORDER BY ts DESC LIMIT 200');
      return res.rows.map(rowToLog);
    },
    async listTimeEntries(date) {
      if (date) {
        const res = await pool.query(
          'SELECT * FROM time_entries WHERE date = $1 OR "endTs" IS NULL ORDER BY "startTs" DESC',
          [date]
        );
        return res.rows.map(rowToTimeEntry);
      }
      const res = await pool.query('SELECT * FROM time_entries ORDER BY "startTs" DESC LIMIT 200');
      return res.rows.map(rowToTimeEntry);
    },
    async getRunningTimer(actor) {
      const res = await pool.query(
        'SELECT * FROM time_entries WHERE actor = $1 AND "endTs" IS NULL ORDER BY "startTs" DESC LIMIT 1',
        [actor]
      );
      return rowToTimeEntry(res.rows[0]);
    },
    async startTimer({ actor, jobId, client, note }) {
      const ts = Date.now();
      await pool.query(
        'UPDATE time_entries SET "endTs" = $1 WHERE actor = $2 AND "endTs" IS NULL',
        [ts, actor]
      );
      const entry = {
        id: newId('tm_'),
        actor: actor || '',
        jobId: jobId || '',
        client: client || '',
        note: String(note || '').trim().slice(0, 200),
        startTs: ts,
        endTs: null,
        date: todayISO()
      };
      await pool.query(
        `INSERT INTO time_entries (id, actor, "jobId", client, note, "startTs", "endTs", date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [entry.id, entry.actor, entry.jobId, entry.client, entry.note, entry.startTs, entry.endTs, entry.date]
      );
      return rowToTimeEntry(entry);
    },
    async stopTimer(actor) {
      const ts = Date.now();
      const prevRes = await pool.query(
        'SELECT * FROM time_entries WHERE actor = $1 AND "endTs" IS NULL ORDER BY "startTs" DESC LIMIT 1',
        [actor]
      );
      const prev = prevRes.rows[0];
      if (!prev) return null;
      await pool.query('UPDATE time_entries SET "endTs" = $1 WHERE id = $2', [ts, prev.id]);
      return rowToTimeEntry({ ...prev, endTs: ts });
    },
    async health() {
      await pool.query('SELECT 1');
      return { driver: 'postgres' };
    }
  };
}

let storePromise;

function getStore() {
  if (!storePromise) {
    storePromise = DATABASE_URL
      ? createPostgresStore(DATABASE_URL)
      : Promise.resolve(createSqliteStore());
  }
  return storePromise;
}

module.exports = {
  STAGES,
  CYCLE,
  STAGE_KEYS,
  ready: () => getStore(),
  listJobs: async () => (await getStore()).listJobs(),
  getJob: async (id) => (await getStore()).getJob(id),
  createJob: async (body) => (await getStore()).createJob(body),
  updateNotes: async (id, notes) => (await getStore()).updateNotes(id, notes),
  cycleStage: async (id, stageKey, actor) => (await getStore()).cycleStage(id, stageKey, actor),
  deleteJob: async (id) => (await getStore()).deleteJob(id),
  listActivity: async (date) => (await getStore()).listActivity(date),
  listTimeEntries: async (date) => (await getStore()).listTimeEntries(date),
  getRunningTimer: async (actor) => (await getStore()).getRunningTimer(actor),
  startTimer: async (body) => (await getStore()).startTimer(body),
  stopTimer: async (actor) => (await getStore()).stopTimer(actor),
  health: async () => (await getStore()).health()
};
