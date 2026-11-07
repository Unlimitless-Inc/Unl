"use strict";
/*
 * THE FIRST HOUR, part one: read what the developer already wrote down (, "HOW UNL
 * EXTRACTS WHAT A DEVELOPER DECIDED", item 1 — the files that are literally decisions).
 *
 * WHAT IT READS. Only the places developers write choices and rules: CLAUDE.md, AGENTS.md, the
 * Cursor and Copilot rule files, CONTRIBUTING, a README's conventions, an ADR folder. Never source
 * code, tests, types or the build: the model can read those itself, and pulling them in would be
 * the pile everyone else builds (item 5).
 *
 * WHAT HAPPENS TO IT. Each file goes to POST /api/v1/import, which pulls out candidate decisions
 * and holds them INERT. Nothing becomes a decision until the developer says so in the
 * conversation with their agent. The files leave this machine only after the developer says yes,
 * and a file already sent unchanged is not sent twice.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  ".cursorrules",
  ".windsurfrules",
  "CONTRIBUTING.md",
  "README.md",
  ".github/copilot-instructions.md",
];
const DIRS = [".cursor/rules", "docs/adr", "docs/adrs", "docs/decisions", "adr", "decisions", "doc/adr"];
const MAX_FILES = 20;
const MAX_BYTES = 128000; // the import route's own text cap (V1_IMPORT_TEXT_CAP)

/**
 * THE STEP UP FROM THE FREE OPEN UNL. The open install keeps one page per decision in
 * .unl/decisions/, each carrying its record, and the hosted importer reads those pages as the records
 * they are: the statement and reason exactly as kept. They go as ONE entry, listed first so the file cap
 * never drops a decision, joined into documents under the route's size cap.
 * The open install has already read the rules files it reads (the same root files as here, and the
 * Cursor rules) and put each rule to the person, who kept it or did not. So when its pages are here they
 * stand in for those files, and those files are not sent: sending them would put the same decisions
 * to the person a second time, re-guessed from prose and some without their reason.
 *
 * AN ADR FOLDER IS HELD TO WHAT THE PAGES THEMSELVES SAY. The open install now reads
 * decision records too, and each page it writes names the file its decision was read from. A record
 * file is left out here only when one of those pages names it, because then its decision arrives as
 * the page, kept or replaced exactly as the person left it, and the same words must not arrive a
 * second time re-read from prose. A record no page names is still sent: one written since the open
 * install last read the folder, one the person has not said yes to, or any record at all where the
 * open install on this machine predates reading them. Nothing is left out on the strength of a folder's
 * name, so nothing the open install did not carry is dropped.
 */
const OPEN_DECISIONS = ".unl/decisions/";
const READ_BY_OPEN = (rel) => ROOT_FILES.includes(rel) || /^\.cursor[\\/]rules[\\/]/.test(rel);
const posix = (p) => String(p).replace(/\\/g, "/");

/** The files the open install's own pages say a kept decision was read from, as paths from the project root. */
function keptFrom(repo) {
  const out = new Set();
  for (const text of openPages(repo)) {
    const m = /<!-- unl:record\s*\n([\s\S]*?)\n-->/.exec(text);
    if (!m) continue;
    try {
      const file = (JSON.parse(m[1]).source || {}).file;
      if (typeof file === "string" && file) out.add(posix(file));
    } catch {}
  }
  return out;
}

function openPages(repo) {
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(repo, OPEN_DECISIONS));
  } catch {
    return [];
  }
  const pages = [];
  for (const e of entries.sort()) {
    if (!/\.md$/i.test(e)) continue;
    try {
      const text = fs.readFileSync(path.join(repo, OPEN_DECISIONS, e), "utf8");
      if (text.includes("<!-- unl:record") && Buffer.byteLength(text) <= MAX_BYTES) pages.push(text);
    } catch {}
  }
  return pages;
}

/** The documents one listed entry sends: a file as it stands, or the open install's pages in as few documents as fit. */
function documentsOf(repo, rel) {
  if (rel === OPEN_DECISIONS) {
    const docs = [];
    let cur = "";
    for (const page of openPages(repo)) {
      const next = cur ? `${cur}\n\n${page}` : page;
      if (cur && Buffer.byteLength(next) > MAX_BYTES) {
        docs.push(cur);
        cur = page;
      } else cur = next;
    }
    if (cur) docs.push(cur);
    return docs.map((text, i) => ({ name: docs.length > 1 ? `${OPEN_DECISIONS} (${i + 1} of ${docs.length})` : OPEN_DECISIONS, key: `${OPEN_DECISIONS}#${i + 1}`, text }));
  }
  return [{ name: rel, key: rel, text: fs.readFileSync(path.join(repo, rel), "utf8") }];
}

function discoverFiles(repo) {
  const found = [];
  const add = (rel) => {
    const abs = path.join(repo, rel);
    try {
      const st = fs.statSync(abs);
      if (st.isFile() && st.size > 0 && st.size <= MAX_BYTES) found.push(rel);
    } catch {}
  };
  const open = openPages(repo).length > 0;
  if (open) found.push(OPEN_DECISIONS);
  for (const f of ROOT_FILES) add(f);
  for (const d of DIRS) {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(repo, d));
    } catch {
      continue;
    }
    for (const e of entries.sort()) if (/\.(md|mdc|markdown|txt)$/i.test(e)) add(path.join(d, e));
  }
  const carried = open ? keptFrom(repo) : new Set();
  return [...new Set(found)].filter((rel) => !(open && (READ_BY_OPEN(rel) || carried.has(posix(rel))))).slice(0, MAX_FILES);
}

function ledgerPath(home) {
  return path.join(home, "imported.json");
}
function readLedger(home) {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(home), "utf8"));
  } catch {
    return {};
  }
}

async function importFiles({ apiBase, key, repo, files, home }) {
  const ledger = readLedger(home);
  const results = [];
  const docs = files.flatMap((rel) => documentsOf(repo, rel));
  for (const { name: rel, key, text } of docs) {
    const digest = crypto.createHash("sha256").update(text).digest("hex");
    const id = `${path.resolve(repo)}::${key}`;
    if (ledger[id] === digest) {
      results.push({ file: rel, skipped: true, found: 0 });
      continue;
    }
    const res = await fetch(`${apiBase}/api/v1/import`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "user-agent": "unl-init/0.1" },
      body: JSON.stringify({ text, name: rel }),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {}
    if (!res.ok) {
      results.push({ file: rel, error: `HTTP ${res.status}${body && body.error ? ` ${body.error}` : ""}` });
      continue;
    }
    const n = Array.isArray(body && body.candidates) ? body.candidates.length : Number((body && body.found) || 0);
    results.push({ file: rel, found: n });
    ledger[id] = digest;
  }
  try {
    fs.writeFileSync(ledgerPath(home), JSON.stringify(ledger, null, 2));
  } catch {}
  return results;
}

module.exports = { discoverFiles, importFiles, OPEN_DECISIONS };
