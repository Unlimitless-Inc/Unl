"use strict";
/*
 * Join decision records into the chains they describe.
 *
 * WHAT A CHAIN IS. A record can say it was replaced ("Superseded by ADR-12") and a record can say
 * what it replaced ("Supersedes ADR-3"). Either one is enough to tie the two together. Followed end
 * to end, the ties give the history of one decision: what it was first, what replaced that, and
 * what stands today.
 *
 * WHY BOTH ENDS ARE KEPT. Who said it matters. When the old record says it was replaced, that is
 * its own status. When only the new record says so, the old one still reads as in force, and two
 * records that cannot both stand is exactly the thing a person has to settle. So every tie
 * keeps which end stated it, and nothing here quietly picks a winner.
 *
 * WHY A REFERENCE IS CHECKED BEFORE IT IS BELIEVED. In a repository with several record folders,
 * "ADR 1" is a different record in each. A reference that carries a name as well as a number is
 * held to the name, so a tie is never made to a record that only shares a number.
 *
 * Pure over the records it is handed. It reads no files.
 */
const path = require("path");
const { plain } = require("./parse");

const posix = (p) => String(p).split(path.sep).join("/");
const titleKey = (s) => plain(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const COMMON = /^(?:this|that|with|from|into|adrs?|madr|record|records|decision|decisions|above|below|other|newer|later|using|use|the|and|for)$/;
const wordsOf = (s) => titleKey(s).split(" ").filter((w) => w.length > 2 && !COMMON.test(w) && !/^\d+$/.test(w));

/** A link's address, made into a repository path. `external` marks a link that leaves the repository. */
function localPath(href, fromFile) {
  let h = String(href || "").trim();
  if (!h || h.startsWith("#") || /^(?:mailto|tel|javascript):/i.test(h)) return null;
  const url = h.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i);
  if (url) return { external: true, tail: (url[1] || "").split(/[?#]/)[0] };
  h = h.split(/[?#]/)[0];
  try {
    h = decodeURIComponent(h);
  } catch {}
  if (!h) return null;
  const base = h.startsWith("/") ? "" : path.posix.dirname(posix(fromFile));
  const joined = path.posix.normalize(path.posix.join(base, h.replace(/^\/+/, "")));
  return { external: false, path: joined.replace(/^\.\//, "") };
}

/** Does a record answer to a name? True when the name has no words to check, or shares one with the title or file. */
function answersTo(record, label) {
  const want = wordsOf(label || "");
  if (!want.length) return true;
  const have = new Set([...wordsOf(record.title), ...wordsOf(path.posix.basename(posix(record.file)).replace(/\.[a-z]+$/i, ""))]);
  return want.some((w) => have.has(w) || [...have].some((h) => h.startsWith(w) || w.startsWith(h)));
}

/**
 * Tie the records together and say where each one stands.
 *
 * Adds to every record: `replacedBy` and `replaces` (the records at the other end of each tie,
 * with which end stated it and whether it was only in part), `lifecycle`, and on each stated
 * relation whether it found its target.
 *
 * lifecycle is one of:
 *   current    in force
 *   to_settle  a later record says it replaced this one and this one does not say so, or it was replaced only in part
 *   replaced   the record itself says it was replaced
 *   retired    deprecated, with nothing named in its place
 *   ruled_out  rejected
 *   proposed   not decided yet
 *   unclear    the record has a status and Unl could not tell what it means, so it is not assumed in force
 */
function linkRecords(records) {
  const byFile = new Map();
  const byBase = new Map();
  const byNumber = new Map();
  const byTitle = new Map();
  const pushTo = (map, key, r) => { if (!map.has(key)) map.set(key, []); map.get(key).push(r); };
  const baseOf = (file) => path.posix.basename(posix(file)).toLowerCase().replace(/\.(?:md|markdown|mdx|rst|html?)$/, "");
  for (const r of records) {
    byFile.set(posix(r.file), r);
    pushTo(byBase, baseOf(r.file), r);
    if (r.number != null) pushTo(byNumber, r.number, r);
    if (r.title) pushTo(byTitle, titleKey(r.title), r);
    r.replacedBy = [];
    r.replaces = [];
  }
  /** The one record in a list that is not `r`, preferring `r`'s own folder. Null when there is none or more than one. */
  const one = (list, r, check) => {
    const all = (list || []).filter((x) => x !== r && (!check || check(x)));
    const near = all.filter((x) => x.folder === r.folder);
    if (near.length === 1) return near[0];
    if (near.length > 1) return null;
    return all.length === 1 ? all[0] : null;
  };

  const resolve = (r, target) => {
    if (!target) return { record: null, dead: false };
    const label = target.label || (target.named ? target.text : "");
    let external = false;
    if (target.href) {
      const loc = localPath(target.href, r.file);
      if (loc && !loc.external) {
        for (const t of [loc.path, loc.path.replace(/\.html?$/i, ".md"), `${loc.path}.md`, `${loc.path}.rst`, `${loc.path.replace(/\/$/, "")}/index.md`]) {
          if (byFile.has(t) && byFile.get(t) !== r) return { record: byFile.get(t), dead: false };
        }
      }
      // A link that misses by path can still name a record's file: site-relative links, renamed folders, full addresses.
      external = !!(loc && loc.external);
      const base = baseOf(loc ? (loc.external ? loc.tail : loc.path) : target.href);
      const hit = base && one(byBase.get(base), r);
      if (hit) return { record: hit, dead: false };
    }
    if (target.number != null) {
      // A name that is exactly one record's title, with that number, is that record, whichever folder it is in.
      // "Supersedes ADR 0001 - MFE Config API" must not be tied to this folder's record 1 because both say "API".
      if (label) {
        const exact = (byNumber.get(target.number) || []).filter((x) => x !== r && titleKey(x.title) === titleKey(label));
        if (exact.length === 1) return { record: exact[0], dead: false };
      }
      const sameFolder = (byNumber.get(target.number) || []).filter((x) => x !== r && x.folder === r.folder);
      const fits = sameFolder.filter((x) => answersTo(x, label));
      if (fits.length === 1) return { record: fits[0], dead: false };
      if (fits.length > 1) return { record: null, dead: true, ambiguous: true };
      // Not in this folder under that name: a record elsewhere with the number counts only when the name fits it too.
      if (wordsOf(label).length) {
        const far = (byNumber.get(target.number) || []).filter((x) => x !== r && x.folder !== r.folder && answersTo(x, label));
        if (far.length === 1) return { record: far[0], dead: false };
      }
    }
    if (label) {
      const exact = one(byTitle.get(titleKey(label)), r);
      if (exact) return { record: exact, dead: false };
      // Named loosely ("the upstream ADR"): taken only when its words pick out exactly one title.
      const want = wordsOf(label);
      if (want.length >= 2) {
        const loose = records.filter((x) => {
          const have = wordsOf(x.title);
          return want.every((w) => have.some((h) => h === w || h.startsWith(w) || w.startsWith(h)));
        });
        const hit = one(loose, r);
        if (hit) return { record: hit, dead: false };
      }
    }
    if (external && target.number == null) return { record: null, dead: false, external: true };
    return { record: null, dead: !!(target.href || target.number != null || target.named) };
  };

  // Each tie is one pair of records, kept with which end stated it.
  const ties = new Map();
  const tie = (older, newer, saidBy, partial) => {
    if (older === newer) return;
    const key = `${older.file}\u0000${newer.file}`;
    if (!ties.has(key)) ties.set(key, { older, newer, saidBy: new Set(), partial: false });
    ties.get(key).saidBy.add(saidBy);
    if (partial) ties.get(key).partial = true;
  };
  for (const r of records) {
    for (const rel of r.relations) {
      const found = resolve(r, rel.target);
      rel.found = found.record ? found.record.file : null;
      rel.dead = !!found.dead;
      if (found.ambiguous) rel.ambiguous = true;
      if (found.external) rel.external = true;
      if (!found.record) continue;
      if (rel.rel === "superseded_by") tie(r, found.record, "older", rel.partial || r.status.state === "partly_superseded");
      if (rel.rel === "supersedes") tie(found.record, r, "newer", rel.partial);
    }
  }
  for (const t of ties.values()) {
    const saidBy = [...t.saidBy].sort();
    t.older.replacedBy.push({ record: t.newer, saidBy, partial: t.partial });
    t.newer.replaces.push({ record: t.older, saidBy, partial: t.partial });
  }

  const folderHasStatus = new Map();
  for (const r of records) if (r.has.status) folderHasStatus.set(r.folder, true);
  // A folder states its statuses when at least two of its records do and they are at least half of it. There,
  // a record with none is not silent by convention: its status is somewhere this reader did not find it, in a
  // badge, a note, a form of its own. Reading that as in force is the mistake that matters, so it is not read.
  const statedIn = new Map();
  for (const r of records) {
    const c = statedIn.get(r.folder) || { all: 0, stated: 0 };
    c.all++;
    if (r.has.status) c.stated++;
    statedIn.set(r.folder, c);
  }
  const statesItsStatuses = (folder) => { const c = statedIn.get(folder); return !!c && c.stated >= 2 && c.stated * 2 >= c.all; };

  for (const r of records) {
    const state = r.status.state;
    const settled = (x) => x.status.state === "accepted" || x.status.state === "unknown";
    const claimedOnlyByNewer = r.replacedBy.filter((t) => !t.saidBy.includes("older") && settled(t.record));
    r.partlyReplaced = state === "partly_superseded" || r.replacedBy.some((t) => t.partial && settled(t.record));
    if (state === "superseded") r.lifecycle = "replaced";
    else if (state === "deprecated") r.lifecycle = "retired";
    else if (state === "rejected") r.lifecycle = "ruled_out";
    else if (state === "proposed" || state === "draft") r.lifecycle = "proposed";
    else if (r.partlyReplaced || claimedOnlyByNewer.length) r.lifecycle = "to_settle";
    else if (state === "unknown" && r.has.status) r.lifecycle = "unclear";
    else if (state === "unknown" && statesItsStatuses(r.folder)) { r.lifecycle = "unclear"; r.statusMissing = true; }
    else r.lifecycle = "current";
    r.statusAssumed = state === "unknown" && r.lifecycle === "current";
    // A folder where no record carries a status has no status convention, so silence there means in force.
    r.folderHasStatuses = !!folderHasStatus.get(r.folder);
  }
  return records;
}

/**
 * The history a record belongs to, oldest first, ending on what stands today. Where a record was
 * replaced by more than one, the first named is followed and the others are still on the record's
 * own `replacedBy`. A loop stops where it closes and is reported.
 */
function chainOf(record) {
  const back = [];
  const seen = new Set([record.file]);
  let cur = record;
  let loop = false;
  while (cur.replaces.length) {
    const prev = cur.replaces[0].record;
    if (seen.has(prev.file)) { loop = true; break; }
    seen.add(prev.file);
    back.unshift(prev);
    cur = prev;
  }
  const forward = [];
  cur = record;
  while (cur.replacedBy.length) {
    const next = cur.replacedBy[0].record;
    if (seen.has(next.file)) { loop = true; break; }
    seen.add(next.file);
    forward.push(next);
    cur = next;
  }
  return { records: [...back, record, ...forward], loop };
}

/** Every chain of two or more records, each listed once, oldest first. */
function allChains(records) {
  const out = [];
  const done = new Set();
  for (const r of records) {
    if (done.has(r.file) || (!r.replaces.length && !r.replacedBy.length)) continue;
    const head = chainOf(chainOf(r).records[0]);
    if (head.records.every((x) => done.has(x.file))) continue;
    for (const x of head.records) done.add(x.file);
    if (head.records.length >= 2) out.push(head);
  }
  return out;
}

module.exports = { linkRecords, chainOf, allChains, localPath, titleKey, answersTo };
