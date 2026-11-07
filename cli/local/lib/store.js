"use strict";
/*
 * The record: a real Postgres database on this machine (PGlite), one per repository.
 *
 * Why a database and not a file. A decision is not a line of text. It has a reason, a date, the person
 * who made it, what it applies to, what it replaced and what later replaced it, and the questions
 * people ask of it are relational: what is current, what did this replace, which decisions were handed
 * to which session, which two cannot both hold. The readable files in the repository are written FROM
 * this record so that every tool that reads a rules file gets the decisions with nothing to connect.
 *
 * Every open goes through the lock (see lock.js), does its work, and closes. Nothing holds the
 * database open between calls, so the hooks, the MCP server and the command line never collide.
 */
const fs = require("fs");
const path = require("path");
const { withLock } = require("./lock");
const { store: storePaths } = require("./paths");

const SCHEMA_VERSION = 1;

const DDL = `
create table if not exists meta (key text primary key, value text not null);

-- A kept decision. id is its address in the published format (computed over what was settled, so it
-- never changes); status and replaced_by are its lifecycle and do change.
create table if not exists decisions (
  id            text primary key,
  ruling_id     text not null unique,
  title         text not null,
  statement     text not null,
  why           text,
  scope         text[] not null default '{}',
  status        text not null check (status in ('canonical','superseded')),
  ratified_by   text not null,
  ratified_at   timestamptz not null,
  settled_on    date,
  record        jsonb not null,
  applies_to    jsonb not null default '{}'::jsonb,
  source        jsonb,
  replaced_by   text references decisions(id),
  replaced_at   timestamptz,
  retired_why   text,
  created_at    timestamptz not null default now(),
  search        tsvector generated always as (
                  setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
                  setweight(to_tsvector('english', coalesce(statement,'')), 'A') ||
                  setweight(to_tsvector('english', coalesce(why,'')), 'B')) stored
);
create index if not exists decisions_search on decisions using gin (search);
create index if not exists decisions_status on decisions (status);

-- Something proposed and not yet decided: read from a file, suggested by an agent, or noticed in a
-- conversation. A proposal never becomes a decision by itself. Only the person's yes does that.
create table if not exists proposals (
  id            text primary key,
  title         text,
  content       text not null,
  why           text,
  scope         text[] not null default '{}',
  applies_to    jsonb not null default '{}'::jsonb,
  source        jsonb,
  replaces      text[] not null default '{}',
  proposed_by   text,
  status        text not null default 'open' check (status in ('open','kept','skipped')),
  decision_id   text references decisions(id),
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

-- How decisions relate: replaces, contradicts, came_from.
create table if not exists edges (
  from_id text not null, kind text not null, to_id text not null, why text,
  created_at timestamptz not null default now(),
  primary key (from_id, kind, to_id)
);

-- Things only the person can settle: a decision with no reason, two that cannot both hold, one that
-- names a file that is no longer there.
create table if not exists flags (
  id text primary key, kind text not null, decision_ids text[] not null default '{}',
  detail jsonb not null default '{}'::jsonb, status text not null default 'open' check (status in ('open','settled','dismissed')),
  created_at timestamptz not null default now(), settled_at timestamptz, settlement text
);

-- Files already read, by content, so an unchanged file is never read twice.
create table if not exists sources (path text primary key, sha256 text not null, read_at timestamptz not null default now());

-- What happened in each agent session: what Unl handed over, when it spoke first, what the person said
-- yes to. Written by the hooks into a journal and folded in here. This is what a receipt is read from.
create table if not exists sessions (id text primary key, host text, root text, started_at timestamptz, last_at timestamptz);
create table if not exists events (
  id text primary key, session_id text not null, at timestamptz not null, kind text not null,
  decision_id text, data jsonb not null default '{}'::jsonb
);
create index if not exists events_session on events (session_id, at);
`;

let pgliteModule = null;
/** Load PGlite from wherever this copy of the runtime can reach it. Named plainly when it cannot. */
function loadPglite() {
  if (pgliteModule) return pgliteModule;
  const tries = [() => require("@electric-sql/pglite"), () => require(path.join(__dirname, "..", "node_modules", "@electric-sql", "pglite"))];
  for (const t of tries) { try { pgliteModule = t(); return pgliteModule; } catch {} }
  throw new Error("Unl's database engine (@electric-sql/pglite) is not installed beside this copy of Unl. Reinstall with `npx unlimitless init`.");
}

/**
 * Open the record, run `fn(db)`, close it. Always under the lock. `fn` gets a small query surface:
 * q(sql, params) -> rows, exec(sql), tx(fn).
 */
async function withStore(storeDir, fn) {
  const p = storePaths(storeDir);
  return withLock(p.lock, async () => {
    const { PGlite } = loadPglite();
    fs.mkdirSync(p.dir, { recursive: true });
    const pg = new PGlite(p.db);
    try {
      await pg.waitReady;
      const db = wrap(pg);
      await migrate(db);
      return await fn(db);
    } finally {
      try { await pg.close(); } catch {}
    }
  });
}

function wrap(pg) {
  const q = async (sql, params = []) => (await pg.query(sql, params)).rows;
  return {
    q,
    one: async (sql, params = []) => (await q(sql, params))[0] || null,
    exec: (sql) => pg.exec(sql),
    tx: (fn) => pg.transaction(async (t) => fn({ q: async (sql, params = []) => (await t.query(sql, params)).rows, one: async (sql, params = []) => ((await t.query(sql, params)).rows)[0] || null, exec: (sql) => t.exec(sql) })),
  };
}

async function migrate(db) {
  await db.exec("create table if not exists meta (key text primary key, value text not null);");
  const row = await db.one("select value from meta where key = 'schema_version'");
  const have = row ? Number(row.value) : 0;
  if (have > SCHEMA_VERSION) throw new Error(`This record was written by a newer Unl (schema ${have}). Update Unl with \`npx unlimitless@latest init\`.`);
  if (have < 1) {
    await db.exec(DDL);
    await db.q("insert into meta(key, value) values ('schema_version', $1) on conflict (key) do update set value = excluded.value", [String(SCHEMA_VERSION)]);
  }
}

// ── decisions ────────────────────────────────────────────────────────────────────────────────────

const DECISION_COLS = "id, ruling_id, title, statement, why, scope, status, ratified_by, ratified_at, settled_on, record, applies_to, source, replaced_by, replaced_at, retired_why, created_at";

/** Insert a decision built by decisions.js. Idempotent on its address: the same decision kept twice is one row. */
async function insertDecision(db, d) {
  const rows = await db.q(
    `insert into decisions (id, ruling_id, title, statement, why, scope, status, ratified_by, ratified_at, settled_on, record, applies_to, source)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict (id) do nothing returning id`,
    [d.id, d.ruling_id, d.title, d.statement, d.why, d.scope, d.status || "canonical", d.ratified_by, d.ratified_at, d.settled_on || null, JSON.stringify(d.record), JSON.stringify(d.applies_to || {}), d.source ? JSON.stringify(d.source) : null]
  );
  return rows.length > 0;
}

/**
 * Mark `oldId` as replaced by `newId` (or retired, when newId is null), and record the edge. One statement each, one transaction.
 * A retired decision has no successor, and to_jsonb of a missing name is a database null, which would blank the
 * whole stored record: the successor is written as a JSON null instead.
 */
async function replaceDecision(db, oldId, newId, { at = new Date().toISOString(), why = null } = {}) {
  const rows = await db.q(
    `update decisions set status = 'superseded', replaced_by = $2, replaced_at = $3, retired_why = $4,
            record = jsonb_set(jsonb_set(record, '{ruling,status}', '"superseded"'), '{provenance,supersededBy}', coalesce(to_jsonb($5::text), 'null'::jsonb))
      where id = $1 and status = 'canonical' returning id`,
    [oldId, newId, at, why, newId ? await rulingIdOf(db, newId) : null]
  );
  if (rows.length && newId) {
    await db.q("insert into edges (from_id, kind, to_id, why) values ($1,'replaces',$2,$3) on conflict do nothing", [newId, oldId, why]);
    // What a decision replaced is lifecycle, outside its address, so the newer record can learn it afterwards.
    const oldRid = await rulingIdOf(db, oldId);
    await db.q(
      `update decisions set record = jsonb_set(record, '{provenance,wasRevisionOfAll}', (record->'provenance'->'wasRevisionOfAll') || to_jsonb($2::text))
        where id = $1 and not (record->'provenance'->'wasRevisionOfAll') ? $2`,
      [newId, oldRid]
    );
  }
  return rows.length > 0;
}

async function rulingIdOf(db, id) {
  const r = await db.one("select ruling_id from decisions where id = $1", [id]);
  return r ? r.ruling_id : null;
}

async function listDecisions(db, { status = null } = {}) {
  // In the order they were kept; decisions kept in one go keep the order they had in the file they came from.
  return db.q(`select ${DECISION_COLS} from decisions ${status ? "where status = $1" : ""} order by ratified_at, source->>'file', (source->>'line_start')::int nulls last, ruling_id`, status ? [status] : []);
}

/** Find one decision by its address, the short form of it a person sees, or its own identifier. Ambiguity is refused, never guessed. */
async function findDecision(db, ref) {
  const r = String(ref || "").trim();
  if (!r) return { decision: null, matches: 0 };
  const rows = await db.q(
    `select ${DECISION_COLS} from decisions where id = $1 or ruling_id = $1 or id like $2 limit 5`,
    [r, "walk1:sha256:" + r.replace(/^walk1:sha256:/, "").replace(/[%_]/g, "") + "%"]
  );
  return { decision: rows.length === 1 ? rows[0] : null, matches: rows.length };
}

/** Full-text search over current decisions. Used by `ask` and the command line; the hooks use the compiled index instead. */
async function searchDecisions(db, text, limit = 8) {
  return db.q(
    `select ${DECISION_COLS}, ts_rank_cd(search, q) as rank from decisions, websearch_to_tsquery('english', $1) q
      where status = 'canonical' and search @@ q order by rank desc limit $2`,
    [String(text || "").slice(0, 600), limit]
  );
}

// ── proposals ────────────────────────────────────────────────────────────────────────────────────

async function insertProposal(db, p) {
  const rows = await db.q(
    `insert into proposals (id, title, content, why, scope, applies_to, source, replaces, proposed_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (id) do nothing returning id`,
    [p.id, p.title || null, p.content, p.why || null, p.scope || [], JSON.stringify(p.applies_to || {}), p.source ? JSON.stringify(p.source) : null, p.replaces || [], p.proposed_by || null]
  );
  return rows.length > 0;
}
const listProposals = (db, status = "open") => db.q("select * from proposals where status = $1 order by created_at, source->>'file', (source->>'line_start')::int nulls last, id", [status]);
async function findProposal(db, ref) {
  const r = String(ref || "").trim();
  const rows = await db.q("select * from proposals where id = $1 or id like $2 limit 5", [r, "cand1:sha256:" + r.replace(/^cand1:sha256:/, "").replace(/[%_]/g, "") + "%"]);
  return { proposal: rows.length === 1 ? rows[0] : null, matches: rows.length };
}
/**
 * Close a waiting proposal its own source no longer supports, saying why on the row. Only an open proposal is closed,
 * and it is closed as skipped, never deleted, so the record of what was offered stands.
 */
const closeProposal = async (db, id, why) =>
  (await db.q("update proposals set status = 'skipped', resolved_at = now(), source = coalesce(source, '{}'::jsonb) || jsonb_build_object('closed', $2::text) where id = $1 and status = 'open' returning id", [id, why])).length > 0;
/** Open again a proposal closed for `why` (and only for that), with the source it is read from now. */
const reopenProposal = async (db, id, source, why) =>
  (await db.q("update proposals set status = 'open', resolved_at = null, source = $2 where id = $1 and status = 'skipped' and source->>'closed' = $3 returning id", [id, JSON.stringify(source), why])).length > 0;
const setProposalSource = (db, id, source) => db.q("update proposals set source = $2 where id = $1 and status = 'open'", [id, JSON.stringify(source)]);
/**
 * What a kept decision knows of where it came from: its file, its lines, where its record stands. This is outside
 * the decision's address and its published record, so following a file that changed never rewrites what was kept.
 */
const setDecisionSource = (db, id, source) => db.q("update decisions set source = $2 where id = $1", [id, JSON.stringify(source)]);
const resolveProposal = (db, id, status, decisionId = null) =>
  db.q("update proposals set status = $2, decision_id = $3, resolved_at = now() where id = $1 and status = 'open' returning id", [id, status, decisionId]);

// ── flags ────────────────────────────────────────────────────────────────────────────────────────

async function upsertFlag(db, f) {
  await db.q(
    `insert into flags (id, kind, decision_ids, detail) values ($1,$2,$3,$4)
     on conflict (id) do update set detail = excluded.detail where flags.status = 'open'`,
    [f.id, f.kind, f.decision_ids || [], JSON.stringify(f.detail || {})]
  );
}
const listFlags = (db, status = "open") => db.q("select * from flags where status = $1 order by created_at, id", [status]);
const settleFlag = (db, id, status, settlement) =>
  db.q("update flags set status = $2, settlement = $3, settled_at = now() where id = $1 and status = 'open' returning id", [id, status, settlement || null]);

// ── sources ──────────────────────────────────────────────────────────────────────────────────────

const sourceSeen = async (db, file, sha) => !!(await db.one("select 1 as x from sources where path = $1 and sha256 = $2", [file, sha]));
const markSource = (db, file, sha) =>
  db.q("insert into sources (path, sha256) values ($1,$2) on conflict (path) do update set sha256 = excluded.sha256, read_at = now()", [file, sha]);

// ── sessions and events ──────────────────────────────────────────────────────────────────────────

/** Fold journal events into the record. Idempotent on the event id, so a journal read twice changes nothing. */
async function ingestEvents(db, events) {
  let added = 0;
  for (const e of events) {
    if (!e || !e.id || !e.session || !e.at || !e.kind) continue;
    await db.q(
      `insert into sessions (id, host, root, started_at, last_at) values ($1,$2,$3,$4,$4)
       on conflict (id) do update set last_at = greatest(sessions.last_at, excluded.last_at), host = coalesce(sessions.host, excluded.host)`,
      [e.session, e.host || null, e.root || null, e.at]
    );
    const rows = await db.q(
      "insert into events (id, session_id, at, kind, decision_id, data) values ($1,$2,$3,$4,$5,$6) on conflict (id) do nothing returning id",
      [e.id, e.session, e.at, e.kind, e.decision || null, JSON.stringify(e.data || {})]
    );
    added += rows.length;
  }
  return added;
}

const getMeta = async (db, key) => { const r = await db.one("select value from meta where key = $1", [key]); return r ? r.value : null; };
const setMeta = (db, key, value) => db.q("insert into meta(key, value) values ($1,$2) on conflict (key) do update set value = excluded.value", [key, String(value)]);

module.exports = {
  withStore, SCHEMA_VERSION, loadPglite,
  insertDecision, replaceDecision, listDecisions, findDecision, searchDecisions,
  insertProposal, listProposals, findProposal, resolveProposal, closeProposal, reopenProposal, setProposalSource, setDecisionSource,
  upsertFlag, listFlags, settleFlag, sourceSeen, markSource, ingestEvents, getMeta, setMeta,
};
