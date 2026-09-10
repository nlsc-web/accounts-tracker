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
    "updatedAt" TEXT,
    "deletedAt" TEXT,
    "deletedBy" TEXT,
    "extraTasks" TEXT
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
    "durationMs" BIGINT,
    detail TEXT
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
    date TEXT NOT NULL,
    "deletedAt" TEXT,
    "deletedBy" TEXT
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

const SQLITE_ALIVE = `(deletedAt IS NULL OR deletedAt = '')`;
const SQLITE_DELETED = `(deletedAt IS NOT NULL AND deletedAt != '')`;
const PG_ALIVE = `("deletedAt" IS NULL OR "deletedAt" = '')`;
const PG_DELETED = `("deletedAt" IS NOT NULL AND "deletedAt" != '')`;

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
    updatedAt: row.updatedAt || '',
    deletedAt: row.deletedAt || '',
    deletedBy: row.deletedBy || '',
    extraTasks: parseExtraTasks(row.extraTasks)
  };
}

function parseExtraTasks(raw) {
  let parsed = [];
  if (typeof raw === 'string' && raw.trim()) {
    try {
      parsed = JSON.parse(raw) || [];
    } catch {
      parsed = [];
    }
  } else if (Array.isArray(raw)) {
    parsed = raw;
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => {
      if (!item || !item.id) return null;
      const title = String(item.title || '').trim().slice(0, 120);
      if (!title) return null;
      return {
        id: String(item.id),
        title,
        status: CYCLE.includes(item.status) ? item.status : 'pending'
      };
    })
    .filter(Boolean);
}

function extraStageKey(taskId) {
  return 'extra:' + taskId;
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
    durationMs,
    deletedAt: row.deletedAt || '',
    deletedBy: row.deletedBy || ''
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
    durationMs: parseDurationMs(row.durationMs),
    detail: row.detail || ''
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
    extraTasks: parseExtraTasks(job.extraTasks),
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

function latestLogs(logs) {
  const map = new Map();
  (logs || []).forEach((e) => {
    const key = `${e.jobId || ''}::${e.stage || ''}::${e.date || ''}`;
    const prev = map.get(key);
    if (!prev || Number(e.ts) > Number(prev.ts)) map.set(key, e);
  });
  return [...map.values()].sort((a, b) => Number(b.ts) - Number(a.ts));
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
  function addColumnIfMissing(table, column, type) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
  addColumnIfMissing('jobs', 'deletedAt', 'TEXT');
  addColumnIfMissing('jobs', 'deletedBy', 'TEXT');
  addColumnIfMissing('jobs', 'extraTasks', 'TEXT');
  addColumnIfMissing('time_entries', 'deletedAt', 'TEXT');
  addColumnIfMissing('time_entries', 'deletedBy', 'TEXT');
  addColumnIfMissing('activity_log', 'detail', 'TEXT');

  return {
    async listJobs() {
      return db
        .prepare(`SELECT * FROM jobs WHERE ${SQLITE_ALIVE} ORDER BY updatedAt DESC, date DESC`)
        .all()
        .map(rowToJob);
    },
    async getJob(id) {
      return rowToJob(
        db.prepare(`SELECT * FROM jobs WHERE id = ? AND ${SQLITE_ALIVE}`).get(id)
      );
    },
    async getJobAny(id) {
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
      return this.updateJob(id, { notes: String(notes || '') });
    },
    async updateJob(id, patch) {
      const prev = await this.getJob(id);
      if (!prev) return null;
      const next = {
        client: patch.client != null ? String(patch.client).trim() : prev.client,
        staff: patch.staff != null ? String(patch.staff).trim() : prev.staff,
        date: patch.date != null ? String(patch.date).trim() : prev.date,
        notes: patch.notes != null ? String(patch.notes) : prev.notes
      };
      if (!next.client) {
        const err = new Error('Client name is required');
        err.status = 400;
        throw err;
      }
      if (patch.date != null && !/^\d{4}-\d{2}-\d{2}$/.test(next.date)) {
        const err = new Error('Invalid job date');
        err.status = 400;
        throw err;
      }
      const now = new Date().toISOString();
      db.prepare(
        'UPDATE jobs SET client = ?, staff = ?, date = ?, notes = ?, updatedAt = ? WHERE id = ?'
      ).run(next.client, next.staff, next.date, next.notes, now, id);
      if (next.client !== prev.client) {
        db.prepare('UPDATE activity_log SET client = ? WHERE jobId = ?').run(next.client, id);
        db.prepare('UPDATE time_entries SET client = ? WHERE jobId = ?').run(next.client, id);
      }
      if (next.staff !== prev.staff) {
        db.prepare('UPDATE activity_log SET staff = ? WHERE jobId = ?').run(next.staff, id);
      }
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
    async addExtraTask(id, title, actor) {
      const prev = await this.getJob(id);
      if (!prev) return null;
      const label = String(title || '').trim().slice(0, 120);
      if (!label) {
        const err = new Error('Type the other work first');
        err.status = 400;
        throw err;
      }
      const extras = prev.extraTasks.slice();
      if (extras.length >= 40) {
        const err = new Error('Too many other-work items on this job');
        err.status = 400;
        throw err;
      }
      const task = { id: newId('xw_'), title: label, status: 'pending' };
      extras.push(task);
      const now = new Date().toISOString();
      db.prepare('UPDATE jobs SET extraTasks = ?, updatedAt = ? WHERE id = ?')
        .run(JSON.stringify(extras), now, id);
      const ts = Date.now();
      db.prepare(`
        INSERT INTO activity_log (id, jobId, client, staff, actor, stage, status, date, ts, durationMs, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newId('log_'), prev.id, prev.client, prev.staff, actor || '',
        extraStageKey(task.id), 'pending', todayISO(), ts, null, task.title
      );
      return this.getJob(id);
    },
    async cycleExtraTask(id, extraId, actor) {
      const prev = await this.getJob(id);
      if (!prev) return null;
      const extras = prev.extraTasks.slice();
      const task = extras.find((t) => t.id === extraId);
      if (!task) return null;
      const next = CYCLE[(CYCLE.indexOf(task.status) + 1) % CYCLE.length];
      task.status = next;
      const now = new Date().toISOString();
      db.prepare('UPDATE jobs SET extraTasks = ?, updatedAt = ? WHERE id = ?')
        .run(JSON.stringify(extras), now, id);
      const ts = Date.now();
      const stage = extraStageKey(task.id);
      let durationMs = null;
      if (next === 'done') {
        const start = db.prepare(
          `SELECT ts FROM activity_log WHERE jobId = ? AND stage = ? AND status = 'progress' ORDER BY ts DESC LIMIT 1`
        ).get(prev.id, stage);
        durationMs = durationMsForDone(start && start.ts, ts);
      }
      db.prepare(`
        INSERT INTO activity_log (id, jobId, client, staff, actor, stage, status, date, ts, durationMs, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newId('log_'), prev.id, prev.client, prev.staff, actor || '',
        stage, next, todayISO(), ts, durationMs, task.title
      );
      return { job: await this.getJob(id) };
    },
    async deleteExtraTask(id, extraId) {
      const prev = await this.getJob(id);
      if (!prev) return null;
      const extras = prev.extraTasks.filter((t) => t.id !== extraId);
      if (extras.length === prev.extraTasks.length) return null;
      const now = new Date().toISOString();
      db.prepare('UPDATE jobs SET extraTasks = ?, updatedAt = ? WHERE id = ?')
        .run(JSON.stringify(extras), now, id);
      return this.getJob(id);
    },
    async deleteJob(id, deletedBy) {
      const job = db.prepare(`SELECT * FROM jobs WHERE id = ? AND ${SQLITE_ALIVE}`).get(id);
      if (!job) return false;
      const now = new Date().toISOString();
      const by = String(deletedBy || '');
      db.prepare('UPDATE jobs SET deletedAt = ?, deletedBy = ?, updatedAt = ? WHERE id = ?')
        .run(now, by, now, id);
      db.prepare(
        `UPDATE time_entries SET deletedAt = ?, deletedBy = ?, endTs = COALESCE(endTs, ?)
         WHERE ${SQLITE_ALIVE} AND (
           jobId = ?
           OR ((jobId = '' OR jobId IS NULL) AND client = ? AND actor = ?)
         )`
      ).run(now, by, Date.now(), id, job.client || '', job.staff || '');
      return true;
    },
    async listDeletedJobs() {
      return db
        .prepare(`SELECT * FROM jobs WHERE ${SQLITE_DELETED} ORDER BY deletedAt DESC`)
        .all()
        .map(rowToJob);
    },
    async restoreJob(id) {
      const job = db.prepare(`SELECT * FROM jobs WHERE id = ? AND ${SQLITE_DELETED}`).get(id);
      if (!job) return null;
      const now = new Date().toISOString();
      db.prepare('UPDATE jobs SET deletedAt = NULL, deletedBy = NULL, updatedAt = ? WHERE id = ?')
        .run(now, id);
      db.prepare(
        `UPDATE time_entries SET deletedAt = NULL, deletedBy = NULL
         WHERE jobId = ? AND ${SQLITE_DELETED}`
      ).run(id);
      return this.getJob(id);
    },
    async purgeJob(id) {
      const job = db.prepare(`SELECT * FROM jobs WHERE id = ? AND ${SQLITE_DELETED}`).get(id);
      if (!job) return false;
      db.prepare(
        'DELETE FROM time_entries WHERE jobId = ? OR ((jobId = \'\' OR jobId IS NULL) AND client = ? AND actor = ?)'
      ).run(id, job.client || '', job.staff || '');
      db.prepare(
        'DELETE FROM activity_log WHERE jobId = ? OR (client = ? AND staff = ?)'
      ).run(id, job.client || '', job.staff || '');
      return db.prepare('DELETE FROM jobs WHERE id = ?').run(id).changes > 0;
    },
    async listActivity(date) {
      const sql = date
        ? `SELECT l.* FROM activity_log l
           INNER JOIN jobs j ON j.id = l.jobId AND ${SQLITE_ALIVE.replace(/deletedAt/g, 'j.deletedAt')}
           WHERE l.date = ?
           ORDER BY l.ts DESC`
        : `SELECT l.* FROM activity_log l
           INNER JOIN jobs j ON j.id = l.jobId AND ${SQLITE_ALIVE.replace(/deletedAt/g, 'j.deletedAt')}
           ORDER BY l.ts DESC LIMIT 200`;
      const rows = date
        ? db.prepare(sql).all(date)
        : db.prepare(sql).all();
      return latestLogs(rows.map(rowToLog));
    },
    async listTimeEntries(date) {
      const sql = date
        ? `SELECT t.* FROM time_entries t
           WHERE ${SQLITE_ALIVE.replace(/deletedAt/g, 't.deletedAt')}
             AND (t.date = ? OR t.endTs IS NULL)
             AND (t.jobId = '' OR t.jobId IS NULL OR EXISTS (
               SELECT 1 FROM jobs j WHERE j.id = t.jobId AND ${SQLITE_ALIVE.replace(/deletedAt/g, 'j.deletedAt')}
             ))
           ORDER BY t.startTs DESC`
        : `SELECT t.* FROM time_entries t
           WHERE ${SQLITE_ALIVE.replace(/deletedAt/g, 't.deletedAt')}
             AND (t.jobId = '' OR t.jobId IS NULL OR EXISTS (
               SELECT 1 FROM jobs j WHERE j.id = t.jobId AND ${SQLITE_ALIVE.replace(/deletedAt/g, 'j.deletedAt')}
             ))
           ORDER BY t.startTs DESC LIMIT 200`;
      const rows = date
        ? db.prepare(sql).all(date)
        : db.prepare(sql).all();
      return rows.map(rowToTimeEntry);
    },
    async getRunningTimer(actor) {
      return rowToTimeEntry(
        db.prepare(
          `SELECT * FROM time_entries WHERE actor = ? AND endTs IS NULL AND ${SQLITE_ALIVE} ORDER BY startTs DESC LIMIT 1`
        ).get(actor)
      );
    },
    async startTimer({ actor, jobId, client, note }) {
      const ts = Date.now();
      db.prepare(
        `UPDATE time_entries SET endTs = ? WHERE actor = ? AND endTs IS NULL AND ${SQLITE_ALIVE}`
      ).run(ts, actor);
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
      const prev = db.prepare(
        `SELECT * FROM time_entries WHERE actor = ? AND endTs IS NULL AND ${SQLITE_ALIVE} ORDER BY startTs DESC LIMIT 1`
      ).get(actor);
      if (!prev) return null;
      db.prepare('UPDATE time_entries SET endTs = ? WHERE id = ?').run(ts, prev.id);
      return rowToTimeEntry({ ...prev, endTs: ts });
    },
    async getTimeEntry(id) {
      return rowToTimeEntry(
        db.prepare(`SELECT * FROM time_entries WHERE id = ? AND ${SQLITE_ALIVE}`).get(id)
      );
    },
    async getTimeEntryAny(id) {
      return rowToTimeEntry(db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id));
    },
    async deleteTimeEntry(id, deletedBy) {
      const prev = db.prepare(`SELECT * FROM time_entries WHERE id = ? AND ${SQLITE_ALIVE}`).get(id);
      if (!prev) return false;
      const now = new Date().toISOString();
      const ts = Date.now();
      db.prepare(
        `UPDATE time_entries SET deletedAt = ?, deletedBy = ?, endTs = COALESCE(endTs, ?) WHERE id = ?`
      ).run(now, String(deletedBy || ''), ts, id);
      return true;
    },
    async listDeletedTimeEntries() {
      return db.prepare(
        `SELECT t.* FROM time_entries t
         WHERE ${SQLITE_DELETED.replace(/deletedAt/g, 't.deletedAt')}
           AND (
             t.jobId = '' OR t.jobId IS NULL
             OR NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = t.jobId)
             OR EXISTS (
               SELECT 1 FROM jobs j
               WHERE j.id = t.jobId AND ${SQLITE_ALIVE.replace(/deletedAt/g, 'j.deletedAt')}
             )
           )
         ORDER BY t.deletedAt DESC`
      ).all().map(rowToTimeEntry);
    },
    async restoreTimeEntry(id) {
      const prev = db.prepare(`SELECT * FROM time_entries WHERE id = ? AND ${SQLITE_DELETED}`).get(id);
      if (!prev) return null;
      if (prev.jobId) {
        const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(prev.jobId);
        if (job && job.deletedAt) {
          const err = new Error('Restore the client job first');
          err.status = 400;
          throw err;
        }
        if (!job) {
          db.prepare('UPDATE time_entries SET jobId = ? WHERE id = ?').run('', id);
        }
      }
      db.prepare('UPDATE time_entries SET deletedAt = NULL, deletedBy = NULL WHERE id = ?').run(id);
      return this.getTimeEntry(id);
    },
    async purgeTimeEntry(id) {
      const prev = db.prepare(`SELECT * FROM time_entries WHERE id = ? AND ${SQLITE_DELETED}`).get(id);
      if (!prev) return false;
      return db.prepare('DELETE FROM time_entries WHERE id = ?').run(id).changes > 0;
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
  await pool.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS "deletedAt" TEXT');
  await pool.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS "deletedBy" TEXT');
  await pool.query('ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS "deletedAt" TEXT');
  await pool.query('ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS "deletedBy" TEXT');
  await pool.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS "extraTasks" TEXT');
  await pool.query('ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS detail TEXT');

  return {
    async listJobs() {
      const res = await pool.query(`SELECT * FROM jobs WHERE ${PG_ALIVE} ORDER BY "updatedAt" DESC, date DESC`);
      return res.rows.map(rowToJob);
    },
    async getJob(id) {
      const res = await pool.query(`SELECT * FROM jobs WHERE id = $1 AND ${PG_ALIVE}`, [id]);
      return rowToJob(res.rows[0]);
    },
    async getJobAny(id) {
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
      return this.updateJob(id, { notes: String(notes || '') });
    },
    async updateJob(id, patch) {
      const prev = await this.getJob(id);
      if (!prev) return null;
      const next = {
        client: patch.client != null ? String(patch.client).trim() : prev.client,
        staff: patch.staff != null ? String(patch.staff).trim() : prev.staff,
        date: patch.date != null ? String(patch.date).trim() : prev.date,
        notes: patch.notes != null ? String(patch.notes) : prev.notes
      };
      if (!next.client) {
        const err = new Error('Client name is required');
        err.status = 400;
        throw err;
      }
      if (patch.date != null && !/^\d{4}-\d{2}-\d{2}$/.test(next.date)) {
        const err = new Error('Invalid job date');
        err.status = 400;
        throw err;
      }
      const now = new Date().toISOString();
      await pool.query(
        'UPDATE jobs SET client = $1, staff = $2, date = $3, notes = $4, "updatedAt" = $5 WHERE id = $6',
        [next.client, next.staff, next.date, next.notes, now, id]
      );
      if (next.client !== prev.client) {
        await pool.query('UPDATE activity_log SET client = $1 WHERE "jobId" = $2', [next.client, id]);
        await pool.query('UPDATE time_entries SET client = $1 WHERE "jobId" = $2', [next.client, id]);
      }
      if (next.staff !== prev.staff) {
        await pool.query('UPDATE activity_log SET staff = $1 WHERE "jobId" = $2', [next.staff, id]);
      }
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
    async addExtraTask(id, title, actor) {
      const prev = await this.getJob(id);
      if (!prev) return null;
      const label = String(title || '').trim().slice(0, 120);
      if (!label) {
        const err = new Error('Type the other work first');
        err.status = 400;
        throw err;
      }
      const extras = prev.extraTasks.slice();
      if (extras.length >= 40) {
        const err = new Error('Too many other-work items on this job');
        err.status = 400;
        throw err;
      }
      const task = { id: newId('xw_'), title: label, status: 'pending' };
      extras.push(task);
      const now = new Date().toISOString();
      await pool.query(
        'UPDATE jobs SET "extraTasks" = $1, "updatedAt" = $2 WHERE id = $3',
        [JSON.stringify(extras), now, id]
      );
      const ts = Date.now();
      await pool.query(
        `INSERT INTO activity_log (id, "jobId", client, staff, actor, stage, status, date, ts, "durationMs", detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          newId('log_'), prev.id, prev.client, prev.staff, actor || '',
          extraStageKey(task.id), 'pending', todayISO(), ts, null, task.title
        ]
      );
      return this.getJob(id);
    },
    async cycleExtraTask(id, extraId, actor) {
      const prev = await this.getJob(id);
      if (!prev) return null;
      const extras = prev.extraTasks.slice();
      const task = extras.find((t) => t.id === extraId);
      if (!task) return null;
      const next = CYCLE[(CYCLE.indexOf(task.status) + 1) % CYCLE.length];
      task.status = next;
      const now = new Date().toISOString();
      await pool.query(
        'UPDATE jobs SET "extraTasks" = $1, "updatedAt" = $2 WHERE id = $3',
        [JSON.stringify(extras), now, id]
      );
      const ts = Date.now();
      const stage = extraStageKey(task.id);
      let durationMs = null;
      if (next === 'done') {
        const start = await pool.query(
          `SELECT ts FROM activity_log WHERE "jobId" = $1 AND stage = $2 AND status = 'progress' ORDER BY ts DESC LIMIT 1`,
          [prev.id, stage]
        );
        durationMs = durationMsForDone(start.rows[0] && start.rows[0].ts, ts);
      }
      await pool.query(
        `INSERT INTO activity_log (id, "jobId", client, staff, actor, stage, status, date, ts, "durationMs", detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          newId('log_'), prev.id, prev.client, prev.staff, actor || '',
          stage, next, todayISO(), ts, durationMs, task.title
        ]
      );
      return { job: await this.getJob(id) };
    },
    async deleteExtraTask(id, extraId) {
      const prev = await this.getJob(id);
      if (!prev) return null;
      const extras = prev.extraTasks.filter((t) => t.id !== extraId);
      if (extras.length === prev.extraTasks.length) return null;
      const now = new Date().toISOString();
      await pool.query(
        'UPDATE jobs SET "extraTasks" = $1, "updatedAt" = $2 WHERE id = $3',
        [JSON.stringify(extras), now, id]
      );
      return this.getJob(id);
    },
    async deleteJob(id, deletedBy) {
      const prev = await this.getJob(id);
      if (!prev) return false;
      const now = new Date().toISOString();
      const by = String(deletedBy || '');
      await pool.query(
        'UPDATE jobs SET "deletedAt" = $1, "deletedBy" = $2, "updatedAt" = $3 WHERE id = $4',
        [now, by, now, id]
      );
      await pool.query(
        `UPDATE time_entries SET "deletedAt" = $1, "deletedBy" = $2, "endTs" = COALESCE("endTs", $3)
         WHERE ${PG_ALIVE} AND (
           "jobId" = $4
           OR (("jobId" = '' OR "jobId" IS NULL) AND client = $5 AND actor = $6)
         )`,
        [now, by, Date.now(), id, prev.client || '', prev.staff || '']
      );
      return true;
    },
    async listDeletedJobs() {
      const res = await pool.query(
        `SELECT * FROM jobs WHERE ${PG_DELETED} ORDER BY "deletedAt" DESC`
      );
      return res.rows.map(rowToJob);
    },
    async restoreJob(id) {
      const existing = await pool.query(
        `SELECT * FROM jobs WHERE id = $1 AND ${PG_DELETED}`,
        [id]
      );
      if (!existing.rows[0]) return null;
      const now = new Date().toISOString();
      await pool.query(
        'UPDATE jobs SET "deletedAt" = NULL, "deletedBy" = NULL, "updatedAt" = $1 WHERE id = $2',
        [now, id]
      );
      await pool.query(
        `UPDATE time_entries SET "deletedAt" = NULL, "deletedBy" = NULL
         WHERE "jobId" = $1 AND ${PG_DELETED}`,
        [id]
      );
      return this.getJob(id);
    },
    async purgeJob(id) {
      const existing = await pool.query(
        `SELECT * FROM jobs WHERE id = $1 AND ${PG_DELETED}`,
        [id]
      );
      const job = existing.rows[0];
      if (!job) return false;
      await pool.query(
        `DELETE FROM time_entries WHERE "jobId" = $1 OR (("jobId" = '' OR "jobId" IS NULL) AND client = $2 AND actor = $3)`,
        [id, job.client || '', job.staff || '']
      );
      await pool.query(
        'DELETE FROM activity_log WHERE "jobId" = $1 OR (client = $2 AND staff = $3)',
        [id, job.client || '', job.staff || '']
      );
      const res = await pool.query('DELETE FROM jobs WHERE id = $1', [id]);
      return res.rowCount > 0;
    },
    async listActivity(date) {
      const sql = date
        ? `SELECT l.* FROM activity_log l
           INNER JOIN jobs j ON j.id = l."jobId" AND ${PG_ALIVE.replace(/"deletedAt"/g, 'j."deletedAt"')}
           WHERE l.date = $1
           ORDER BY l.ts DESC`
        : `SELECT l.* FROM activity_log l
           INNER JOIN jobs j ON j.id = l."jobId" AND ${PG_ALIVE.replace(/"deletedAt"/g, 'j."deletedAt"')}
           ORDER BY l.ts DESC LIMIT 200`;
      const res = date
        ? await pool.query(sql, [date])
        : await pool.query(sql);
      return latestLogs(res.rows.map(rowToLog));
    },
    async listTimeEntries(date) {
      const sql = date
        ? `SELECT t.* FROM time_entries t
           WHERE ${PG_ALIVE.replace(/"deletedAt"/g, 't."deletedAt"')}
             AND (t.date = $1 OR t."endTs" IS NULL)
             AND (t."jobId" = '' OR t."jobId" IS NULL OR EXISTS (
               SELECT 1 FROM jobs j WHERE j.id = t."jobId" AND ${PG_ALIVE.replace(/"deletedAt"/g, 'j."deletedAt"')}
             ))
           ORDER BY t."startTs" DESC`
        : `SELECT t.* FROM time_entries t
           WHERE ${PG_ALIVE.replace(/"deletedAt"/g, 't."deletedAt"')}
             AND (t."jobId" = '' OR t."jobId" IS NULL OR EXISTS (
               SELECT 1 FROM jobs j WHERE j.id = t."jobId" AND ${PG_ALIVE.replace(/"deletedAt"/g, 'j."deletedAt"')}
             ))
           ORDER BY t."startTs" DESC LIMIT 200`;
      const res = date
        ? await pool.query(sql, [date])
        : await pool.query(sql);
      return res.rows.map(rowToTimeEntry);
    },
    async getRunningTimer(actor) {
      const res = await pool.query(
        `SELECT * FROM time_entries WHERE actor = $1 AND "endTs" IS NULL AND ${PG_ALIVE} ORDER BY "startTs" DESC LIMIT 1`,
        [actor]
      );
      return rowToTimeEntry(res.rows[0]);
    },
    async startTimer({ actor, jobId, client, note }) {
      const ts = Date.now();
      await pool.query(
        `UPDATE time_entries SET "endTs" = $1 WHERE actor = $2 AND "endTs" IS NULL AND ${PG_ALIVE}`,
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
        `SELECT * FROM time_entries WHERE actor = $1 AND "endTs" IS NULL AND ${PG_ALIVE} ORDER BY "startTs" DESC LIMIT 1`,
        [actor]
      );
      const prev = prevRes.rows[0];
      if (!prev) return null;
      await pool.query('UPDATE time_entries SET "endTs" = $1 WHERE id = $2', [ts, prev.id]);
      return rowToTimeEntry({ ...prev, endTs: ts });
    },
    async getTimeEntry(id) {
      const res = await pool.query(`SELECT * FROM time_entries WHERE id = $1 AND ${PG_ALIVE}`, [id]);
      return rowToTimeEntry(res.rows[0]);
    },
    async getTimeEntryAny(id) {
      const res = await pool.query('SELECT * FROM time_entries WHERE id = $1', [id]);
      return rowToTimeEntry(res.rows[0]);
    },
    async deleteTimeEntry(id, deletedBy) {
      const prevRes = await pool.query(
        `SELECT * FROM time_entries WHERE id = $1 AND ${PG_ALIVE}`,
        [id]
      );
      const prev = prevRes.rows[0];
      if (!prev) return false;
      const now = new Date().toISOString();
      await pool.query(
        `UPDATE time_entries SET "deletedAt" = $1, "deletedBy" = $2, "endTs" = COALESCE("endTs", $3) WHERE id = $4`,
        [now, String(deletedBy || ''), Date.now(), id]
      );
      return true;
    },
    async listDeletedTimeEntries() {
      const res = await pool.query(
        `SELECT t.* FROM time_entries t
         WHERE ${PG_DELETED.replace(/"deletedAt"/g, 't."deletedAt"')}
           AND (
             t."jobId" = '' OR t."jobId" IS NULL
             OR NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = t."jobId")
             OR EXISTS (
               SELECT 1 FROM jobs j
               WHERE j.id = t."jobId" AND ${PG_ALIVE.replace(/"deletedAt"/g, 'j."deletedAt"')}
             )
           )
         ORDER BY t."deletedAt" DESC`
      );
      return res.rows.map(rowToTimeEntry);
    },
    async restoreTimeEntry(id) {
      const prevRes = await pool.query(
        `SELECT * FROM time_entries WHERE id = $1 AND ${PG_DELETED}`,
        [id]
      );
      const prev = prevRes.rows[0];
      if (!prev) return null;
      if (prev.jobId) {
        const jobRes = await pool.query('SELECT * FROM jobs WHERE id = $1', [prev.jobId]);
        const job = jobRes.rows[0];
        if (job && job.deletedAt) {
          const err = new Error('Restore the client job first');
          err.status = 400;
          throw err;
        }
        if (!job) {
          await pool.query('UPDATE time_entries SET "jobId" = $1 WHERE id = $2', ['', id]);
        }
      }
      await pool.query(
        'UPDATE time_entries SET "deletedAt" = NULL, "deletedBy" = NULL WHERE id = $1',
        [id]
      );
      return this.getTimeEntry(id);
    },
    async purgeTimeEntry(id) {
      const prevRes = await pool.query(
        `SELECT * FROM time_entries WHERE id = $1 AND ${PG_DELETED}`,
        [id]
      );
      if (!prevRes.rows[0]) return false;
      const res = await pool.query('DELETE FROM time_entries WHERE id = $1', [id]);
      return res.rowCount > 0;
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
  getJobAny: async (id) => (await getStore()).getJobAny(id),
  createJob: async (body) => (await getStore()).createJob(body),
  updateNotes: async (id, notes) => (await getStore()).updateNotes(id, notes),
  updateJob: async (id, patch) => (await getStore()).updateJob(id, patch),
  cycleStage: async (id, stageKey, actor) => (await getStore()).cycleStage(id, stageKey, actor),
  addExtraTask: async (id, title, actor) => (await getStore()).addExtraTask(id, title, actor),
  cycleExtraTask: async (id, extraId, actor) => (await getStore()).cycleExtraTask(id, extraId, actor),
  deleteExtraTask: async (id, extraId) => (await getStore()).deleteExtraTask(id, extraId),
  deleteJob: async (id, deletedBy) => (await getStore()).deleteJob(id, deletedBy),
  listDeletedJobs: async () => (await getStore()).listDeletedJobs(),
  restoreJob: async (id) => (await getStore()).restoreJob(id),
  purgeJob: async (id) => (await getStore()).purgeJob(id),
  listActivity: async (date) => (await getStore()).listActivity(date),
  listTimeEntries: async (date) => (await getStore()).listTimeEntries(date),
  getRunningTimer: async (actor) => (await getStore()).getRunningTimer(actor),
  startTimer: async (body) => (await getStore()).startTimer(body),
  stopTimer: async (actor) => (await getStore()).stopTimer(actor),
  getTimeEntry: async (id) => (await getStore()).getTimeEntry(id),
  getTimeEntryAny: async (id) => (await getStore()).getTimeEntryAny(id),
  deleteTimeEntry: async (id, deletedBy) => (await getStore()).deleteTimeEntry(id, deletedBy),
  listDeletedTimeEntries: async () => (await getStore()).listDeletedTimeEntries(),
  restoreTimeEntry: async (id) => (await getStore()).restoreTimeEntry(id),
  purgeTimeEntry: async (id) => (await getStore()).purgeTimeEntry(id),
  health: async () => (await getStore()).health()
};
