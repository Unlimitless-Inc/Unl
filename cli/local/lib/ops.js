"use strict";
/*
 * The operations everything else is built from. The command line, the MCP server and the hooks all
 * come through here, so there is one place where the record is changed and one order it happens in:
 * change the record, re-run the checks, rebuild the index the hooks read, rewrite the view.
 */
const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const store = require("./store");
const journal = require("./journal");
const decisions = require("./decisions");
const { runChecks } = require("./checks");
const { refreshIndex } = require("./index");
const { writeView, readView } = require("./view");
const { extract, sameKey } = require("./extract");

const DEFAULT_FILES = ["AGENTS.md"];

async function viewFiles(db) {
  try { const v = JSON.parse((await store.getMeta(db, "view_files")) || "null"); return Array.isArray(v) && v.length ? v : DEFAULT_FILES; } catch { return DEFAULT_FILES; }
}

/** After any change: checks, index, view. Returns the files of the view that changed. */
async function settle(db, project, { write = true } = {}) {
  // Decision records read from a folder carry their own history: what replaced what is settled first.
  await require("./adr/store").settleChains(db);
  const all = await store.listDecisions(db);
  const current = all.filter((d) => d.status === "canonical");
  const fresh = runChecks(current, project.root);
  const freshIds = new Set(fresh.map((f) => f.id));
  for (const f of fresh) await store.upsertFlag(db, f);
  // A flag about a decision that has since been replaced, or a path that is back, has answered itself.
  for (const f of await store.listFlags(db, "open")) if (!freshIds.has(f.id)) await store.settleFlag(db, f.id, "dismissed", "no longer applies");
  const index = await refreshIndex(db, project.storeDir);
  const changed = write ? writeView(project.root, all, { files: await viewFiles(db) }) : [];
  return { index, changed, flags: await store.listFlags(db, "open") };
}

/** Take in what the hooks journalled, and any decision files that arrived through git. */
async function takeIn(db, project) {
  const events = journal.readAll(project.storeDir).map(journal.forRecord);
  const eventsAdded = await store.ingestEvents(db, events);
  let arrived = 0;
  const refused = [];
  const files = readView(project.root);
  const have = new Set((await store.listDecisions(db)).map((d) => d.id));
  // First every decision, then who replaced whom, so a replacement can point at a row that exists.
  for (const f of files) {
    if (f.error) { if (f.error !== "no record in this file") refused.push({ name: f.name, why: f.error }); continue; }
    const r = f.record;
    if (have.has(r.id)) continue;
    await store.insertDecision(db, {
      id: r.id, ruling_id: r.ruling.id, title: r.ruling.title, statement: r.ruling.statement, why: r.why.overall_why,
      scope: r.ruling.authority_scope, status: "canonical", ratified_by: r.provenance.ratifiedBy, ratified_at: r.provenance.ratifiedAt,
      settled_on: f.settled_on || null, record: { ...r, ruling: { ...r.ruling, status: "canonical" }, provenance: { ...r.provenance, supersededBy: null } },
      applies_to: f.applies_to || {}, source: f.source || null,
    });
    have.add(r.id);
    arrived++;
  }
  const all = await store.listDecisions(db);
  const byRid = new Map(all.map((d) => [d.ruling_id, d]));
  for (const f of files) {
    if (f.error) continue;
    const mine = byRid.get(f.record.ruling.id);
    if (!mine || mine.status !== "canonical") continue;
    // A file that says this decision was replaced: by another (named), or retired (status superseded, no successor).
    const byRidName = f.record.provenance.supersededBy;
    if (byRidName && byRid.get(byRidName)) await store.replaceDecision(db, mine.id, byRid.get(byRidName).id, { at: f.replaced_at || undefined });
    else if (f.record.ruling.status === "superseded") await store.replaceDecision(db, mine.id, null, { at: f.replaced_at || undefined, why: f.retired_why || null });
    // A newer decision in the files that names this one as replaced.
    for (const rid of f.record.provenance.wasRevisionOfAll || []) {
      const old = byRid.get(rid);
      if (old && old.status === "canonical" && old.id !== mine.id) await store.replaceDecision(db, old.id, mine.id, { at: mine.ratified_at });
    }
  }
  return { eventsAdded, arrived, refused };
}

/** The whole round: take in, settle. What `unl sync` and most commands run. */
async function sync(project, opts = {}) {
  return store.withStore(project.storeDir, async (db) => {
    const taken = await takeIn(db, project);
    const settled = await settle(db, project, opts);
    return { ...taken, ...settled };
  });
}

/**
 * Read rules files into proposals. Returns, per file, what was found. A file already read unchanged is
 * skipped. The same rule written in two files is one proposal that remembers both places.
 */
async function readFiles(db, project, files) {
  const results = [];
  const known = new Map();
  for (const d of await store.listDecisions(db)) known.set(sameKey(d.statement), d);
  for (const p of await store.listProposals(db, "open")) known.set(sameKey(p.content), p);
  for (const rel of files) {
    let text;
    try { text = fs.readFileSync(path.join(project.root, rel), "utf8"); } catch { results.push({ file: rel, error: "could not be read" }); continue; }
    const sha = createHash("sha256").update(text).digest("hex");
    if (await store.sourceSeen(db, rel, sha)) { results.push({ file: rel, skipped: true, found: 0, added: 0 }); continue; }
    const items = extract(text, rel);
    let added = 0;
    // Files are read one after another in the same instant, so each proposal is stamped a moment after
    // the last: they then list in the order the person wrote them.
    for (const it of items) {
      const key = sameKey(it.statement);
      if (known.has(key)) continue;
      const { proposal, added: isNew } = await decisions.propose(db, { title: it.title, content: it.statement, why: it.why, scope: it.scope, applies_to: it.applies_to, source: it.source, proposed_by: "import" });
      known.set(key, proposal);
      if (isNew) added++;
    }
    await store.markSource(db, rel, sha);
    results.push({ file: rel, found: items.length, added });
  }
  return results;
}

/**
 * When was this line first written? From git, if the project has it. Null when it cannot be told, which
 * includes a shallow copy whose history stops at the commit git names (see history.js).
 */
function firstWritten(root, source) {
  if (!source || !source.file || !source.line_start) return null;
  const { spawnSync } = require("child_process");
  const r = spawnSync("git", ["log", "-1", "--format=%H %as", `-L${source.line_start},${source.line_start}:${source.file}`, "--no-patch"], { cwd: root, encoding: "utf8", timeout: 8000 });
  const m = r.status === 0 ? /^([0-9a-f]{40,64}) (\d{4}-\d{2}-\d{2})/m.exec(String(r.stdout || "")) : null;
  if (!m || require("./history").atEdge(root, m[1])) return null;
  return m[2];
}

/** Keep open proposals on the person's yes. `ids` null means all open ones that came from files. */
async function keepProposals(db, project, { person, ids = null, at = new Date(), dates = false }) {
  const open = await store.listProposals(db, "open");
  const chosen = ids ? open.filter((p) => ids.includes(p.id)) : open.filter((p) => p.proposed_by === "import");
  const kept = [];
  for (const p of chosen) {
    const settled_on = dates ? firstWritten(project.root, p.source) : null;
    const out = await decisions.keepProposal(db, p, { person, at, settled_on });
    kept.push(out.decision);
  }
  return kept;
}

module.exports = { settle, takeIn, sync, readFiles, keepProposals, firstWritten, viewFiles, DEFAULT_FILES };
