"use strict";
/*
 * Read one architecture decision record.
 *
 * WHAT IT IS FOR. People have kept decisions by hand for years as ADRs: a title, a status, the
 * context, the decision and its consequences. This turns one such file into a plain object that
 * says the same things, in the author's own words, so Unl can show it back and keep it.
 *
 * WHY IT READS STRUCTURE AND NEVER JUDGES. An ADR already says which part is the decision and which
 * part is the reason, so nothing here has to guess what someone meant. Every field is copied from
 * the place the author put it. Where the record does not say something, the field is empty and the
 * caller can say so. A reader that filled gaps with its own reading would be deciding for the
 * person, and the whole point of a kept decision is that only the person decided it.
 *
 * WHAT IT ACCEPTS. The shapes that are in real use: Nygard's form as adr-tools writes it, MADR with
 * its header bullets or its YAML front matter, log4brains, the Cosmos style, and the many hand-made
 * mixes of them. Anything it cannot place is kept as written and named, never dropped silently.
 *
 * Pure. Text in, an object out. No file system, no network, no clock.
 */
const crypto = require("crypto");
const { toMarkdown } = require("./markup");

/** The longest statement or reason carried on a record. Past it the text is cut at a sentence end and marked. */
const MAX_TEXT = 600;
/** The most supporting points taken from one record. More than this is a list, and the count is reported. */
const MAX_POINTS = 12;

/** Status words, each mapped to the one state it means. */
const STATE_WORDS = [
  ["accepted", /\b(?:accepted|approved|adopted|agreed|decided|ratified|implemented|implementable|active|final|done|completed?|in[ -]?force|in[ -]?effect)\b/gi],
  ["proposed", /\b(?:proposed|proposal|pending|provisional|under[ -]?review|in[ -]?review|under[ -]?discussion|in[ -]?discussion|in[ -]?consideration|under[ -]?consideration|in[ -]?progress|on[ -]?hold|deferred|postponed|wip|rfc|open|last[ -]?call)\b/gi],
  ["draft", /\b(?:draft|drafted|drafting|incomplete)\b/gi],
  ["rejected", /\b(?:rejected|declined|refused|withdrawn|abandoned|cancelled|canceled|not[ -]?accepted|won'?t[ -]?do)\b/gi],
  ["deprecated", /\b(?:deprecated|obsolete|retired|inactive|discontinued|reverted|revoked|rescinded|archived)\b/gi],
  ["superseded", /\b(?:super[sc]ee?ded|replaced|supplanted|obsoleted)\b/gi],
];

/**
 * Words that tie one record to another. `rel` is read from the record that carries the words, so
 * "superseded_by" means this record was replaced and the target replaced it.
 *
 * The spellings "superceded" and "superseeded" are accepted on purpose. adr-tools writes the first,
 * so most Nygard-style folders carry it, and the second turns up in hand-written ones.
 */
const RELATIONS = [
  ["superseded_by", "(?:super[sc]ee?ded|replaced|supplanted|obsoleted|deprecated)\\s+(?:by|in\\s+favou?r\\s+of|with)"],
  ["supersedes", "(?:super[sc]ee?des?|super[sc]ee?ding|replaces|replacing|supplants|obsoletes|deprecates)"],
  ["amended_by", "(?:amended|extended|refined|clarified|updated|modified|complemented)\\s+by"],
  ["amends", "(?:amends|extends|refines|clarifies|updates|modifies|complements)"],
  ["relates", "(?:relates\\s+to|related\\s+to|see\\s+also|depends\\s+on|builds\\s+on|follows\\s+from|influenced\\s+by|part\\s+of|refers\\s+to)"],
];

/** Headings, read into the part of the record they name. First match wins, so the narrow ones come first. */
const SECTION_KEYS = [
  ["drivers", /^(?:decision\s+drivers?|drivers?|forces)\b/],
  ["deciders", /^(?:deciders?|decision[- ]makers?|authors?|approvers?|participants|stakeholders|owners?)\b/],
  ["status", /^(?:status|state|decision\s+status|current\s+status)\b/],
  ["date", /^(?:date|decision\s+date|decided\s+on)$/],
  ["tags", /^(?:tags?|labels?|categor(?:y|ies)|components?|areas?)$/],
  ["options", /^(?:considered\s+options?|options?\s+considered|considered\s+alternatives?|alternatives?\s+considered|alternatives?|options?|alternative\s+solutions?|other\s+options?|rejected\s+(?:alternatives?|options?)|possible\s+solutions?)\b/],
  ["proscons", /^(?:pros\s+and\s+cons|pros\s*(?:&|\/)\s*cons|comparison|evaluation)\b/],
  ["consequences", /^(?:consequences?|positive\s+consequences?|negative\s+consequences?|implications?|impact|trade[- ]?offs?|outcomes?\s+and\s+consequences?|positive|negative|neutral|risks?)\b/],
  ["decision", /^(?:decision\s+outcome|decisions?|the\s+decision|decided|resolution|outcome|chosen\s+option|solution)\b/],
  ["proposal", /^(?:proposals?|proposed\s+(?:solution|approach|change|design)|recommendations?|recommended\s+(?:solution|approach|option)|approach|design|detailed\s+design)\b/],
  ["rationale", /^(?:rationale|justification|reasoning|reasons?|why)\b/],
  ["context", /^(?:context|problem|background|motivation|issue|the\s+issue|situation|current\s+state)\b/],
  ["summary", /^(?:summary|abstract|overview|introduction|tl;?dr)\b/],
  ["links", /^(?:links?|related|references?|more\s+information|see\s+also|further\s+reading|related\s+(?:decisions?|adrs?|documents?)|resources)\b/],
  ["changelog", /^(?:changelog|change\s+log|history|revision\s+history|revisions?)$/],
];

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const monthOf = (word) => MONTHS[String(word || "").slice(0, 3).toLowerCase()] || null;
const EMPTY_VALUE = /^(?:true|false|yes|no|none|null|n\/a|na|tbd|-|\u2013|\u2014)?$/i;

/**
 * Replace every HTML comment with blanks of the same shape, so line numbers hold and template hints vanish.
 * One pass, by position: a pattern that looks for the close from every open reads a file of unclosed
 * comments over and over. One that never closes is not a comment, and nothing after it can be one.
 */
function blankHtmlComments(text) {
  let out = "";
  let at = 0;
  for (;;) {
    const open = text.indexOf("<!--", at);
    if (open < 0) break;
    const close = text.indexOf("-->", open + 4);
    if (close < 0) break;
    out += text.slice(at, open) + text.slice(open, close + 3).replace(/[^\n]/g, " ");
    at = close + 3;
  }
  return out + text.slice(at);
}

/** The longest line read. A record's lines are a few hundred characters; this bounds a crafted one. */
const MAX_LINE = 2000;
/**
 * A line as it is read: its indent kept, runs of spaces inside it made one, and cut at a length no
 * real record reaches. The patterns here are written for lines people type. A heading followed by
 * five thousand spaces is not one, and held the first version of this reader for half a minute.
 */
function tidyLine(line) {
  const indent = /^[ \t]{0,12}/.exec(line)[0];
  return (indent + line.slice(indent.length).replace(/[ \t]{2,}/g, " ")).slice(0, MAX_LINE);
}

/** Strip the markdown a reader does not say out loud. Keeps the words of a link, drops its address. */
function plain(text) {
  return String(text == null ? "" : text)
    // Bytes that drive a terminal are not words. A record's title is printed, so they are dropped here.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    // An image keeps the words it was given: a status written as a badge says its status there.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, a, b) => b || a)
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=$|[\s).,;:!?])/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Cut text at the last sentence end inside the cap. Returns the text and whether anything was left off. */
function capAtSentence(text, max = MAX_TEXT) {
  const t = String(text || "").trim();
  if (t.length <= max) return { text: t, cut: false };
  const head = t.slice(0, max);
  const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (stop > max * 0.4) return { text: head.slice(0, stop + 1).trim(), cut: true };
  const space = head.lastIndexOf(" ");
  return { text: (space > max * 0.4 ? head.slice(0, space) : head).trim() + " ...", cut: true };
}

/** A date in any of the shapes people write, as YYYY-MM-DD. Null when it cannot be read without guessing. */
function readDate(raw) {
  const s = plain(raw).replace(/(\d)(?:st|nd|rd|th)\b/gi, "$1");
  if (!s) return null;
  const ok = (y, m, d) => {
    if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    // A day that is not on the calendar ("2021-02-30") is a typing slip, and it is left unread rather than kept.
    const real = new Date(Date.UTC(y, m - 1, d));
    if (real.getUTCMonth() !== m - 1 || real.getUTCDate() !== d) return null;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  let m = s.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = s.match(/(?:^|\D)(\d{4})(\d{2})(\d{2})(?:\D|$)/);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = s.match(/\b(\d{4})\s+([A-Za-z]{3,9})\.?\s+(\d{1,2})\b/);
  if (m && monthOf(m[2])) return ok(+m[1], monthOf(m[2]), +m[3]);
  m = s.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
  if (m && monthOf(m[2])) return ok(+m[3], monthOf(m[2]), +m[1]);
  m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m && monthOf(m[1])) return ok(+m[3], monthOf(m[1]), +m[2]);
  // 03/04/2021 could be either order, so only an unambiguous day is read.
  m = s.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a > 12 && b <= 12) return ok(+m[3], b, a);
    if (b > 12 && a <= 12) return ok(+m[3], a, b);
    if (a === b) return ok(+m[3], a, b);
    return null;
  }
  m = s.match(/\b([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
  if (m && monthOf(m[1])) return `${m[2]}-${String(monthOf(m[1])).padStart(2, "0")}`;
  m = s.match(/\b(\d{4})[-/](\d{1,2})\b/);
  if (m && +m[1] >= 1990 && +m[1] <= 2100 && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${String(+m[2]).padStart(2, "0")}`;
  return null;
}

/**
 * The YAML front matter of a record, read flat: `key: value`, quoted values, and lists written
 * either inline or as dashes. That is everything ADR front matter uses, and reading only that keeps
 * this file free of a YAML dependency. Returns the keys (lowercased) and where the body starts.
 */
function readFrontMatter(lines) {
  if (!lines.length || !/^---\s*$/.test(lines[0])) return { fm: {}, start: 0 };
  let end = -1;
  for (let i = 1; i < Math.min(lines.length, 200); i++) {
    if (/^(?:---|\.\.\.)\s*$/.test(lines[i])) { end = i; break; }
  }
  if (end < 0) return { fm: {}, start: 0 };
  const fm = {};
  let key = null;
  const unquote = (v) => v.trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
  for (let i = 1; i < end; i++) {
    const line = lines[i].replace(/\s+#\s.*$/, "");
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && key) {
      if (!Array.isArray(fm[key])) fm[key] = fm[key] ? [fm[key]] : [];
      const v = unquote(item[1]);
      if (v) fm[key].push(v);
      continue;
    }
    const kv = line.match(/^([A-Za-z][\w .-]*?)\s*:\s*(.*)$/);
    if (!kv) continue;
    key = kv[1].trim().toLowerCase().replace(/[ _]+/g, "-");
    const v = kv[2].trim();
    if (!v || /^[|>][+-]?$/.test(v)) { fm[key] = ""; continue; }
    const list = v.match(/^\[(.*)\]$/);
    fm[key] = list ? list[1].split(",").map(unquote).filter(Boolean) : unquote(v);
  }
  return { fm, start: end + 1 };
}

/** Every heading in the body, ATX or setext, with fenced code left out. */
function readHeadings(lines, start) {
  const out = [];
  let fence = null;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const atx = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/) || (!out.length ? line.match(/^(#)(\d{1,5}[.):]\s+\S.*?)\s*$/) : null);
    if (atx) { out.push({ level: atx[1].length, text: atx[2], line: i }); continue; }
    const next = lines[i + 1];
    if (next !== undefined && line.trim() && !/^\s*(?:[-*+>|]|\d+[.)])\s/.test(line) && (i === start || !lines[i - 1].trim())) {
      if (/^\s{0,3}={2,}\s*$/.test(next)) { out.push({ level: 1, text: line.trim(), line: i, setext: true }); i++; continue; }
      if (/^\s{0,3}-{2,}\s*$/.test(next)) { out.push({ level: 2, text: line.trim(), line: i, setext: true }); i++; continue; }
    }
  }
  return out;
}

/** A heading's words, reduced to what names the section: no numbering, no markup, no trailing colon. */
function headingKey(text) {
  const t = plain(text).toLowerCase().replace(/^[\d.)\s]+/, "").replace(/[:.\s]+$/, "").replace(/[^\p{L}\p{N}&/;' -]+/gu, " ").replace(/\s+/g, " ").trim();
  for (const [key, re] of SECTION_KEYS) if (re.test(t)) return key;
  return null;
}

/** The title with its number taken off, and the number. "# 12. Use a queue", "ADR-012: Use a queue", "[ADR 12] Use a queue". */
function splitTitle(raw) {
  let t = plain(raw);
  let number = null;
  if (!/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(t)) {
    const forms = [
      /^\[?\s*(?:adr|madr|decision)[\s#:_-]*0*(\d{1,5})\s*\]?\s*[:.)\u2013\u2014-]*\s*(.*)$/i,
      /^#?0*(\d{1,4})\s*[.):\u2013\u2014-]\s+(.+)$/,
      /^(0\d{2,4}|\d{3})\s+(.+)$/,
    ];
    for (const re of forms) {
      const m = t.match(re);
      if (m) { number = Number(m[1]); t = m[2].trim(); break; }
    }
  }
  t = t.replace(/^(?:adr|architecture decision record)\s*[:\u2013\u2014-]\s*/i, "").trim();
  return { title: t, number };
}

/** The number, the date and the words a file name carries: "0012-use-a-queue.md", "adr-012.md", or a date run together in front of the name, as log4brains writes it. */
function readFileName(file) {
  const base = String(file || "").split(/[\\/]/).pop().replace(/\.(?:md|markdown|mdx|rst)$/i, "");
  let m = base.match(/^(\d{4})[-_]?(\d{2})[-_]?(\d{2})[-_ ](.+)$/);
  if (m && +m[1] >= 1990 && +m[1] <= 2100 && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) {
    return { number: null, date: `${m[1]}-${m[2]}-${m[3]}`, slug: m[4] };
  }
  m = base.match(/^(?:adr|madr|decision)?[-_ ]?0*(\d{1,5})(?:[-_. ]+(.*))?$/i);
  if (m) return { number: Number(m[1]), date: null, slug: m[2] || "" };
  return { number: null, date: null, slug: base };
}

/** The name in a reference, without its number: "1. Record architecture decisions" gives "Record architecture decisions". */
function nameIn(label) {
  return plain(label).replace(/^[\s:,\u2013\u2014-]+/, "").replace(/^(?:(?:adr|madr)[\s#:_-]*)?0*\d{1,5}[\s.:)\u2013\u2014-]*/i, "").replace(/\.(?:md|markdown|mdx|rst)$/i, "").replace(/[\s.,;:]+$/, "").trim();
}

/**
 * The records a piece of text points at. A target is a markdown link, a wiki link, or a number
 * written as "ADR-12" or "ADR 0012". A bare number counts only when it is the first thing said,
 * so the day in "replaced on 4 March" is never read as record 4.
 */
function readTargets(text) {
  const targets = [];
  const seen = new Set();
  const push = (t) => {
    const k = `${t.href || ""}|${t.number == null ? "" : t.number}|${t.href ? "" : t.text || ""}`;
    if (!seen.has(k)) { seen.add(k); targets.push(t); }
  };
  let rest = String(text || "");
  rest = rest.replace(/\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, label, href) => {
    const n = (label.match(/\b(?:adr|madr)[\s#:_-]*0*(\d{1,5})\b/i) || label.match(/^\s*#?0*(\d{1,4})\b/) || [])[1];
    push({ href, text: plain(label), number: n ? Number(n) : null, label: nameIn(label) });
    return " ";
  });
  rest = rest.replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (_m, page) => {
    const n = (page.match(/0*(\d{1,5})/) || [])[1];
    push({ href: page.trim(), text: page.trim(), number: n ? Number(n) : null, wiki: true });
    return " ";
  });
  rest = rest.replace(/(?:^|[\s:(])((?:[\w.-]+\/)*[\w.-]+\.(?:md|markdown|mdx|rst|adoc))(?=$|[\s.,;)])/gi, (m, file) => {
    const n = (file.split("/").pop().match(/^(?:adr|madr)?[-_ ]?0*(\d{1,5})(?=[-_. ])/i) || [])[1];
    push({ href: file, text: file, number: n ? Number(n) : null });
    return " ";
  });
  const byNumber = [...rest.matchAll(/\b(?:adr|madr)[\s#:_-]*0*(\d{1,5})\b/gi)];
  for (const m of byNumber) {
    // "ADR 0001, MFE Config API (in part)": the name after the number says which record 1 is meant, when only one is named.
    // What follows is a name only when it reads as one. "ADR-0007, which covers both cases" and "ADR-0003 now
    // that the queue exists" go on to say something else, and a record must not be held to those words.
    const after = rest.slice(m.index + m[0].length);
    const clause = /^[\s,:\u2013\u2014-]*(?:which|that|who|whose|now|since|because|as|so|when|where|while|after|before|once|if|but|or|for|to|in|on|is|was|has|had|see|per|due|from|until)\b/i.test(after);
    const label = byNumber.length === 1 && !clause ? nameIn(after.split(/[(;]|\s+and\s+|\.\s|\.$/)[0]) : "";
    push({ number: Number(m[1]), text: m[0].trim(), label });
  }
  if (!targets.length) {
    // "0037-use-nx-for-monorepo": a number that opens a record's file name, with or without the name after it.
    const bare = rest.match(/^\s*(?:[:#]|no\.?|number)?\s*0*(\d{1,5})(?=$|[\s.,;)]|[-_][A-Za-z])/i);
    if (bare) push({ number: Number(bare[1]), text: rest.trim().split(/\s/)[0].replace(/^[:#]+/, "").replace(/[.,;)]+$/, "") });
  }
  return targets;
}

/**
 * Every tie to another record that a piece of text states, line by line. One line can state more
 * than one ("Supersedes ADR-3 and is amended by ADR-9"), so each relation takes the text that
 * follows it up to the next relation word.
 *
 * `anchored` is for prose, where the words are everywhere and most are not about this record. It
 * keeps only a line that opens with the relation, with or without "This ADR" in front of it.
 */
function readRelations(text, { baseLine = 0, anchored = false } = {}) {
  const out = [];
  const lines = String(text || "").split("\n");
  const lead = "^\\s*(?:>\\s*)*(?:[-*+]\\s+|\\d+[.)]\\s+)?(?:\\*\\*|__|_|\\*)?\\s*(?:(?:this|the)\\s+(?:adr|decision|record|document)\\s+|it\\s+)?(?:is\\s+|was\\s+|has\\s+been\\s+|will\\s+be\\s+)?(?:now\\s+|partially\\s+|partly\\s+)?";
  for (let i = 0; i < lines.length; i++) {
    // In prose a tie counts only where it opens a paragraph or a list item. A sentence that wraps can put
    // "replaced by [the edge cache](...)" at the start of a line, and that is the middle of a thought about
    // something else, not this record's status.
    if (anchored && i > 0 && lines[i - 1].trim() && !/^\s{0,3}#{1,6}\s/.test(lines[i - 1]) && !/^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) continue;
    // Emphasis is dropped first, so "**Replaced** by" reads as the two words it is.
    let line = lines[i].replace(/\*\*|__/g, "");
    // "Superseded by" at the end of a line has its target on the next one.
    if (!anchored && /\b(?:by|of|with|supersedes?|supercedes?|replaces|amends|extends)\s*:?\s*$/i.test(line) && lines[i + 1] && lines[i + 1].trim()) line = `${line.trimEnd()} ${lines[i + 1].trim()}`;
    const partial = /\b(?:partial(?:ly)?|partly|in\s+part)\b/i.test(line);
    const hits = [];
    for (const [rel, src] of RELATIONS) {
      const g = new RegExp(anchored ? `${lead}(${src})\\b` : `\\b(${src})\\b`, "gi");
      let m;
      while ((m = g.exec(line))) {
        hits.push({ rel, at: m.index, end: m.index + m[0].length });
        if (anchored) break;
      }
    }
    if (!hits.length) continue;
    // "Superseded by" must win over the "supersedes" its letters could also match, so the longer hit is kept.
    hits.sort((a, b) => a.at - b.at || b.end - a.end);
    const kept = [];
    for (const h of hits) if (!kept.some((k) => h.at < k.end && h.end > k.at)) kept.push(h);
    for (let k = 0; k < kept.length; k++) {
      const tail = line.slice(kept[k].end, k + 1 < kept.length ? kept[k + 1].at : undefined);
      // "Superseded by: N/A" is a form's field left empty. It names nothing and says nothing happened.
      if (NO_VALUE.test(plain(tail).replace(/^[\s:,\u2013\u2014-]+/, "").replace(/[\s.;,)]+$/, ""))) continue;
      const targets = readTargets(tail);
      if (targets.length) for (const t of targets) out.push({ rel: kept[k].rel, target: t, line: baseLine + i, words: plain(line).slice(0, 200), ...(partial ? { partial: true } : {}) });
      else {
        // Named in words only ("Replaced by the upstream ADR"): kept as said, so it can be matched to a title or quoted back.
        const said = plain(tail).replace(/^[\s:,\u2013\u2014-]+/, "").replace(/[\s.;,)]+$/, "").replace(/^\(?see\s+/i, "");
        const named = !anchored && said.length >= 4 && said.length <= 90 && /[A-Za-z]{3}/.test(said) ? { text: said, number: null, named: true } : null;
        out.push({ rel: kept[k].rel, target: named, line: baseLine + i, words: plain(line).slice(0, 200), ...(partial ? { partial: true } : {}) });
      }
    }
  }
  return out;
}

/** What a form's field holds when nobody filled it in. */
const NO_VALUE = /^(?:n\/?a|none|null|nil|tbd|no|not\s+applicable|false|[-\u2013\u2014])$/i;
/** A line of a status that is such a field about another record: "Superseded by: N/A", "Supersedes: none". */
const NO_TIE_LINE = /^\s*(?:[-*+]\s+)?(?:super[sc]ee?ded\s+by|super[sc]ee?des|replaced\s+by|replaces|amended\s+by|amends|deprecated\s+by|obsoleted\s+by)\s*:?\s*(?:n\/?a|none|null|nil|tbd|no|not\s+applicable|false|[-\u2013\u2014])\s*\.?\s*$/i;

/** The states a piece of text names, in the order it names them. */
function statesNamed(text) {
  const found = [];
  for (const [state, re] of STATE_WORDS) {
    const g = new RegExp(re.source, "gi");
    let m;
    while ((m = g.exec(text))) found.push({ state, at: m.index });
  }
  return found.sort((a, b) => a.at - b.at);
}

const REACHED = /\u2705|\u2714|\u2611|\uD83D\uDFE2|\b(?:yes|done|true)\b/i;

/**
 * A status written as a table. Two shapes are in use. One lists stages with a mark against each
 * one reached ("Approved | check"), and the record stands at the last stage reached. The other
 * has a row named Status whose second cell is the status in words.
 */
function readStatusTable(lines) {
  const rows = lines
    .filter((l) => /^\s*\|.*\|\s*$/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l))
    .map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  if (rows.length < 2) return null;
  const body = rows.slice(1);
  const named = body.find((r) => /^(?:status|state|decision)$/i.test(plain(r[0])));
  if (named) return { text: named.slice(1).join(" ") };
  let reached = null;
  let stages = 0;
  for (const r of body) {
    const stage = statesNamed(plain(r[0]));
    if (!stage.length) continue;
    stages++;
    if (REACHED.test(r.slice(1).join(" "))) reached = stage[0].state;
  }
  if (!stages) return null;
  return { state: reached || "proposed" };
}

/**
 * The state a status says.
 *
 * "Superseded" always wins, because a record that says it was replaced is replaced whatever else
 * the line says. Otherwise the first state word wins: a status leads with where the record stands
 * and then explains ("Proposed, pending a trial; hosting already decided"). The one exception is a
 * status that lists its own history line by line, which ends on where it stands now.
 *
 * "template" is returned for a blank form's menu of choices or a legend, which is no status at all.
 */
function readState(raw) {
  // What is struck through is what the status used to be. A status is a few lines: anything past that is
  // not read as one, and blank lines in a run are one gap.
  const lines = String(raw == null ? "" : raw).slice(0, 4000).replace(/~~[^~\n]{0,400}~~/g, " ").replace(/\n{3,}/g, "\n\n").split("\n").map((l) => l.replace(/^\s*>\s?/, "")).filter((l) => !NO_TIE_LINE.test(plain(l)));
  const table = readStatusTable(lines);
  const outside = lines.filter((l) => !/^\s*\|.*\|\s*$/.test(l)).join("\n");
  // "{ accepted }" is a status with a template's braces left around it. "{proposed | accepted}" is still the template's menu.
  const text = plain(table && table.text ? `${outside}\n${table.text}` : outside).replace(/\{[ \t]{0,40}([^{}|\n]{0,200}?)[ \t]{0,40}\}/g, "$1");
  const named = statesNamed(text);
  const distinct = new Set(named.map((n) => n.state));
  // A menu or a legend names many states at once, on one line. Prose under a status can name several without being one.
  const lead = (text.split("\n").find((l) => l.trim()) || "").trim();
  const leadNamed = statesNamed(lead);
  const leadStates = new Set(leadNamed.map((n) => n.state));
  const dense = leadNamed.length / Math.max(1, lead.split(/[\s|/,=]+/).filter(Boolean).length) >= 0.3;
  if (/\{[^}]*\}/.test(text) || (dense && (leadStates.size >= 4 || (leadStates.size >= 3 && /[|/]/.test(lead))))) return "template";
  if (distinct.has("superseded") && saysReplaced(text)) {
    // Replaced in part is not replaced: some of it still stands, and only the person knows which part.
    return /\b(?:partial(?:ly)?|partly|in\s+part)\s+(?:super[sc]ee?ded|replaced|supplanted|obsoleted)\b|\b(?:super[sc]ee?ded|replaced|supplanted|obsoleted)\s+(?:in\s+part|partial(?:ly)?|partly)\b/i.test(text) ? "partly_superseded" : "superseded";
  }
  if (/\b(?:partial(?:ly)?|partly|in\s+part)\s+(?:deprecated|obsolete|retired)\b/i.test(text)) return "partly_superseded";
  if (/\bdeprecated\s+(?:by|in\s+favou?r\s+of)\b/i.test(text)) return "superseded";
  if (table && table.state) return table.state;
  if (!text) return "unknown";
  // A history: two or more lines that each open with a state. The last one is where it stands.
  const opening = [];
  for (const l of text.split("\n")) {
    const t = l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/^[\d\s:./-]+/, "").trim();
    const first = statesNamed(t).filter((n) => n.state !== "superseded")[0];
    if (first && first.at <= 3) opening.push(first.state);
  }
  if (opening.length >= 2) return opening[opening.length - 1];
  const rest = named.filter((n) => n.state !== "superseded");
  if (!rest.length) return "unknown";
  // "Proposed -> Accepted" on one line is also a history.
  const arrow = text.split("\n")[0].split(/\s*(?:->|=>|\u2192|\u27F6|\bthen\b)\s*/i);
  if (arrow.length > 1) {
    const last = statesNamed(arrow[arrow.length - 1]).filter((n) => n.state !== "superseded")[0];
    if (last) return last.state;
  }
  if (rest[0].state !== "accepted") return rest[0].state;
  // The first word says in force. Two things can take that back, and a record wrongly read as in force is
  // the one mistake that hands an agent a dead decision as a live one.
  // A word in front of it: "Not approved", "To be decided", "No longer in force".
  const before = text.slice(Math.max(0, rest[0].at - 40), rest[0].at);
  if (/\b(?:no\s+longer|not\s+any\s*more)\s+(?:\w+\s+){0,2}$/i.test(before)) return "deprecated";
  if (/\b(?:to\s+be|not\s+yet|yet\s+to\s+be|awaiting|pending|still\s+to\s+be)\s+(?:\w+\s+){0,1}$/i.test(before)) return "proposed";
  if (/\b(?:not|never|un)\s*(?:been\s+)?$/i.test(before)) return "unknown";
  // A word after it that says it stopped: "Accepted. Deprecated since 2023.", "Accepted (deprecated)". Which
  // of the two stands is not something to guess, so the status is not understood and the record is not kept.
  if (rest.slice(1).some((n) => n.state === "deprecated" || n.state === "rejected")) return "unknown";
  return "accepted";
}

/**
 * Does a status say this record was replaced? "Superseded", "Replaced by ADR 9" and "is now replaced" do.
 * "Accepted. Replaced the cron job in March." says what this record replaced, and "has not been
 * superseded" says the opposite. So the word counts when something replaced this record ("by", "in
 * favour of", "with", "in part"), or when it is how the status or a line of it opens.
 */
function saysReplaced(text) {
  const word = /\b(?:super[sc]ee?ded|replaced|supplanted|obsoleted)\b/gi;
  let m;
  while ((m = word.exec(text))) {
    const start = text.lastIndexOf("\n", m.index - 1) + 1;
    const lead = text.slice(start, m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 24);
    if (/\b(?:not|never)\s+(?:been\s+)?$/i.test(lead)) continue;
    if (/^\s+(?:by|in\s+favou?r\s+of|with|in\s+part|partial(?:ly)?|partly)\b/i.test(after)) return true;
    if (/^[\s>*_+\d.):-]*(?:(?:this|the)\s+(?:adr|decision|record|document)\s+)?(?:(?:is|was|has\s+been|now|status\s*:?)\s+){0,3}(?:partial(?:ly)?\s+|partly\s+)?$/i.test(lead)) return true;
  }
  return false;
}

/** The bullets of a block, each as one line of plain words. A bullet that wraps is joined back together. */
function readBullets(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || "").split("\n")) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) { if (cur !== null) { out.push(cur); cur = null; } continue; }
    const b = line.match(/^\s{0,6}(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/);
    if (b) { if (cur !== null) out.push(cur); cur = b[1]; continue; }
    if (cur !== null && line.trim() && /^\s+/.test(line)) { cur += " " + line.trim(); continue; }
    if (cur !== null) { out.push(cur); cur = null; }
  }
  if (cur !== null) out.push(cur);
  return out.map(plain).filter(Boolean);
}

/** The paragraphs of a block, with headings, lists, tables, code and images left out. */
function readParagraphs(text) {
  const out = [];
  let cur = [];
  let fence = false;
  const flush = () => { if (cur.length) out.push(plain(cur.join(" "))); cur = []; };
  for (const line of String(text || "").split("\n")) {
    if (/^\s{0,3}(?:`{3,}|~{3,})/.test(line)) { fence = !fence; flush(); continue; }
    if (fence) continue;
    if (!line.trim()) { flush(); continue; }
    if (/^\s{0,3}#{1,6}\s/.test(line) || /^\s{0,3}(?:={2,}|-{2,})\s*$/.test(line)) { flush(); continue; }
    if (/^\s*\|/.test(line) || /^\s{0,3}(?:[-*+]|\d+[.)])\s/.test(line) || /^\s*!\[/.test(line) || /^\s{0,3}(?:[-*_]\s*){3,}$/.test(line)) { flush(); continue; }
    if (/^\s{4,}\S/.test(line) && !cur.length) continue;
    cur.push(line.replace(/^\s*>\s?/, "").trim());
  }
  flush();
  return out.filter(Boolean);
}

/** A line that labels something else ("Technical Story: ...", "Issue: #12"), which is not what the section says. */
const LABEL_LINE = /^(?:technical story|story|issue|ticket|jira|related issue|related|see|ref|reference|link|epic|pr|pull request)s?\s*:/i;

/** The first thing a block says, as prose: its first paragraph, or its first bullets when it has no prose. */
function firstSaid(text) {
  const paras = readParagraphs(text).filter((p) => !LABEL_LINE.test(p) && p.length > 2);
  if (paras.length) return paras[0];
  const bullets = readBullets(text);
  return bullets.length ? bullets.slice(0, 4).join("; ") : "";
}

/**
 * Header lines that carry a key and a value: "* Status: accepted", "Date: 2021-03-04",
 * "**Deciders:** Ana, Raj", or a two-cell table row. Read only from the top of the record, before
 * its first section, where every format that uses them puts them.
 */
function readHeaderPairs(lines, from, to) {
  const pairs = {};
  // The line may sit inside a quoted block, as a status does when it is written as a note.
  const pairLine = /^\s{0,6}(?:>\s*)*(?:[-*+]\s+)?(?:\*\*|__)?([A-Za-z][A-Za-z -]{1,28}?)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*?)\s*$/;
  for (let i = from; i < to; i++) {
    const line = lines[i];
    let m = line.match(pairLine);
    if (m && /^(?:https?|ftp|mailto)$/i.test(m[1])) m = null;
    if (!m) {
      const row = line.match(/^\s*\|\s*(?:\*\*)?([A-Za-z][A-Za-z -]{1,28}?)(?:\*\*)?\s*:?\s*\|\s*(.*?)\s*\|\s*$/);
      if (row && !/^[-: ]*$/.test(row[2])) m = row;
    }
    if (!m) continue;
    const key = m[1].trim().toLowerCase().replace(/\s+/g, "-");
    let value = m[2];
    // A value can run onto indented lines below it, as a list of deciders often does.
    while (i + 1 < to && /^\s{2,}\S/.test(lines[i + 1]) && !pairLine.test(lines[i + 1])) value += " " + lines[++i].trim();
    if (!(key in pairs)) pairs[key] = { value, line: i };
  }
  return pairs;
}

/** The lines a section covers, heading included, without the blank lines at its end. */
function span(section, lines) {
  let last = section.end - 1;
  while (last > section.line && !String(lines[last] || "").trim()) last--;
  return [section.line + 1, last + 1];
}

const listOf = (v) => (Array.isArray(v) ? v : String(v || "").split(/[,;]|\s+and\s+/)).map((s) => plain(String(s)).replace(/^@/, "")).filter((s) => s && !EMPTY_VALUE.test(s));

/**
 * Read one record.
 *
 * @param {string} text  the file's text
 * @param {string} file  its path, as the person would name it (used for the number, the date and provenance)
 * @returns the record. `kind` is "adr" for a decision record, "template" for a blank form, and
 *          "other" for a file that carries none of a record's parts.
 */
function parseAdr(text, file = "") {
  const original = String(text || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const digest = crypto.createHash("sha256").update(original).digest("hex");
  const lines = blankHtmlComments(toMarkdown(original, file)).split("\n").map(tidyLine);
  // Which lines sit inside a fenced example. What a record shows as an example is not the record speaking.
  const fenced = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f && !fence) { fence = f[1][0]; fenced[i] = true; continue; }
    if (f && f[1][0] === fence) { fence = null; fenced[i] = true; continue; }
    fenced[i] = !!fence;
  }
  const { fm, start } = readFrontMatter(lines);
  const headings = readHeadings(lines, start);
  const name = readFileName(file);

  // The title: the first top-level heading, else front matter, else a first heading that names no section.
  const titleHeading = headings.find((h) => h.level === 1) || (headings[0] && !headingKey(headings[0].text) ? headings[0] : null);
  const titleRaw = (titleHeading && titleHeading.text) || (typeof fm.title === "string" && fm.title) || name.slug.replace(/[-_]+/g, " ");
  const { title, number: titleNumber } = splitTitle(titleRaw);
  const number = name.number != null ? name.number : titleNumber;

  // Sections: what sits under each heading, up to the next heading of the same depth or shallower.
  const sections = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (h === titleHeading) continue;
    const bodyStart = h.line + (h.setext ? 2 : 1);
    const nextAny = headings[i + 1] ? headings[i + 1].line : lines.length;
    let nextPeer = lines.length;
    for (let j = i + 1; j < headings.length; j++) if (headings[j].level <= h.level) { nextPeer = headings[j].line; break; }
    sections.push({ key: headingKey(h.text), heading: plain(h.text), level: h.level, line: h.line, end: nextPeer, own: lines.slice(bodyStart, nextAny).join("\n"), full: lines.slice(bodyStart, nextPeer).join("\n") });
  }
  const first = (key) => sections.find((s) => s.key === key) || null;
  const all = (key) => sections.filter((s) => s.key === key);

  // The header: the lines between the title and the first section.
  const headFrom = titleHeading ? titleHeading.line + (titleHeading.setext ? 2 : 1) : start;
  const firstSection = headings.find((h) => h !== titleHeading && h.line >= headFrom);
  const headTo = firstSection ? firstSection.line : Math.min(lines.length, headFrom + 40);
  // Some records put their header above the title ("Status: Deprecated", then the heading). Read there too;
  // what sits under the title wins where both say something.
  const pairs = { ...(titleHeading && titleHeading.line > start ? readHeaderPairs(lines, start, titleHeading.line) : {}), ...readHeaderPairs(lines, headFrom, headTo) };
  const pair = (...keys) => { for (const k of keys) if (pairs[k] && !EMPTY_VALUE.test(plain(pairs[k].value))) return pairs[k].value; return null; };
  const front = (...keys) => { for (const k of keys) if (fm[k] != null && fm[k] !== "" && !(typeof fm[k] === "string" && EMPTY_VALUE.test(fm[k]))) return fm[k]; return null; };

  // Status: front matter, then the header line, then the Status section.
  const statusSection = first("status");
  // "## Status: Deprecated" says the status in the heading, and what follows is its explanation.
  const inHeading = statusSection ? statusSection.heading.replace(/^[\d.)\s]*(?:current\s+|decision\s+)?(?:status|state)\b[\s:\u2013\u2014-]*/i, "").trim() : "";
  const sectionStatus = statusSection ? [inHeading, statusSection.full].filter((v) => v.trim()).join("\n") : null;
  const statusRaw = [front("status", "state"), pair("status", "state", "decision-status"), sectionStatus]
    .map((v) => (Array.isArray(v) ? v.join("\n") : v))
    .find((v) => v != null && String(v).trim() !== "");
  let statusText = statusRaw == null ? "" : String(statusRaw).trim();
  if (!statusText) {
    // "**Status**" on a line of its own, with the status in the paragraph under it.
    const label = lines.findIndex((l, i) => i >= headFrom && !fenced[i] && /^\s*(?:\*\*|__)?\s*(?:current\s+)?status\s*(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*$/i.test(l));
    if (label >= 0) {
      const said = [];
      for (let i = label + 1; i < lines.length && said.length < 4; i++) {
        if (!lines[i].trim()) { if (said.length) break; continue; }
        if (/^\s{0,3}#{1,6}\s/.test(lines[i]) || fenced[i]) break;
        said.push(lines[i].trim());
      }
      statusText = said.join("\n");
    }
  }
  if (!statusText) {
    // No status where a status goes. Some records say it in one emphasised line of their own instead:
    // "**Deprecated. See decision 029**". At the top it speaks for the whole record. Further down it sits
    // under one part of it, so the record is replaced in part and the person is asked which part stands.
    const isMarker = (l) => /^\s*(?:>\s*)*(?:\*\*|__)\s*(?:partial(?:ly)?\s+|partly\s+)?(?:super[sc]ee?ded|deprecated|replaced|obsolete|retired|rejected|withdrawn)\b[^*_]*(?:\*\*|__)\s*$/i.test(l);
    const at = lines.findIndex((l, i) => i >= headFrom && !fenced[i] && isMarker(l));
    if (at >= 0) {
      const said = lines[at].replace(/^\s*(?:>\s*)*/, "").replace(/\*\*|__/g, "").trim();
      statusText = at <= headFrom + 12 || /^(?:partial|partly)/i.test(said) ? said : `Partly ${said.charAt(0).toLowerCase()}${said.slice(1)}`;
    }
  }
  let state = readState(statusText);

  // Ties to other records: stated in the status, in the header, in a links section, or at the start of a line of prose.
  const relations = [];
  const statusLine = statusSection ? statusSection.line + 1 : pairs.status ? pairs.status.line : 0;
  for (const r of readRelations(statusText, { baseLine: statusLine })) relations.push({ ...r, where: "status" });
  const headerRel = [
    ["superseded_by", ["superseded-by", "supersededby", "replaced-by", "replacedby", "superceded-by", "obsoleted-by", "deprecated-by"]],
    ["supersedes", ["supersedes", "replaces", "supercedes", "obsoletes", "deprecates"]],
    ["amended_by", ["amended-by", "extended-by"]],
    ["amends", ["amends", "extends"]],
    ["relates", ["related", "relates-to", "related-to", "see-also"]],
  ];
  const headerValues = { ...Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, v.value])), ...fm };
  for (const [rel, keys] of headerRel) {
    for (const k of keys) {
      const v = headerValues[k];
      if (v == null) continue;
      for (const item of Array.isArray(v) ? v : [v]) {
        if (EMPTY_VALUE.test(plain(String(item)))) continue;
        const targets = readTargets(String(item));
        const partial = /\b(?:partial(?:ly)?|partly|in\s+part)\b/i.test(String(item));
        for (const t of targets.length ? targets : [{ text: plain(String(item)), number: null, named: true }]) relations.push({ rel, target: t, line: pairs[k] ? pairs[k].line : 0, words: `${k}: ${plain(String(item))}`.slice(0, 200), where: "header", ...(partial ? { partial: true } : {}) });
      }
    }
  }
  const statusSpan = statusSection ? [statusSection.line, statusSection.end] : null;
  const bodyText = lines.map((l, i) => (i < headFrom || fenced[i] || (statusSpan && i >= statusSpan[0] && i < statusSpan[1]) ? "" : l)).join("\n");
  // In prose the words are everywhere, so a tie counts only when it names a record, and one already stated above is not repeated.
  for (const r of readRelations(bodyText, { anchored: true })) {
    if (!r.target || (r.target.href == null && r.target.number == null)) continue;
    if (relations.some((x) => x.rel === r.rel && x.line === r.line)) continue;
    relations.push({ ...r, where: "body" });
  }
  // A record that names what replaced it is replaced, wherever in the record it says so.
  if (!["template", "superseded", "partly_superseded"].includes(state) && relations.some((r) => r.rel === "superseded_by" && (r.where !== "body" || r.target))) state = "superseded";

  // The date: where the record says it, else its change log, else the file name.
  const dateRaw = [front("date", "decision-date", "decided", "created"), pair("date", "decision-date", "decided", "created"), first("date") && first("date").own]
    .map((v) => (Array.isArray(v) ? v[0] : v))
    .find((v) => v != null && String(v).trim() !== "");
  let date = dateRaw ? readDate(String(dateRaw)) : null;
  let dateSource = date ? "record" : null;
  if (!date && first("changelog")) {
    for (const line of first("changelog").own.split("\n")) {
      const d = line.trim() ? readDate(line.split(/:\s/)[0]) || readDate(line) : null;
      if (d) { date = d; dateSource = "change log"; break; }
    }
  }
  if (!date && name.date) { date = name.date; dateSource = "file name"; }

  const sectionList = (key) => (first(key) ? readBullets(first(key).own).join(", ") || firstSaid(first(key).own) : "");
  const deciders = listOf(front("deciders", "decision-makers", "decision-maker", "authors", "author") || pair("deciders", "decision-makers", "decision-maker", "authors", "author") || sectionList("deciders"));
  const tags = listOf(front("tags", "tag", "labels", "category", "categories", "component", "components", "area") || pair("tags", "tag", "labels", "category", "component", "area") || sectionList("tags"))
    .map((t) => t.toLowerCase().replace(/^#/, "").replace(/\s+/g, "-"))
    .filter((t) => t && t.length <= 40);

  // The decision, in the author's words.
  // Some records never use the word and put what was decided under "Proposal" or "Approach".
  const decisionSection = first("decision") || first("proposal");
  let statement = "";
  let chosen = null;
  let because = null;
  if (decisionSection) {
    const said = firstSaid(decisionSection.own) || firstSaid(decisionSection.full);
    const m = said.match(/^(chosen\s+(?:option|alternative|solution)s?\s*[:\u2013\u2014-]\s*)([\s\S]+)$/i);
    if (m) {
      const at = m[2].search(/[,;.]?\s+because\b/i);
      const picked = at >= 0 ? m[2].slice(0, at) : m[2];
      because = at >= 0 ? m[2].slice(at).replace(/^[,;.]?\s+because\b[\s:,]*/i, "").trim() : null;
      if (because === "") because = readBullets(decisionSection.own).slice(0, 4).join("; ") || null;
      chosen = picked.trim().replace(/^["'“‘[*_]+|["'”’\]*_.,;]+$/g, "").trim();
      statement = (m[1] + picked).trim().replace(/[,;]+$/, "");
    } else statement = said;
  }
  const statementCap = capAtSentence(statement);

  // The reason: what the decision itself gives, else a rationale section, else the context.
  const contextSection = first("context");
  const rationaleSection = first("rationale");
  const contextSaid = contextSection ? firstSaid(contextSection.own) || firstSaid(contextSection.full) : "";
  const rationaleSaid = rationaleSection ? firstSaid(rationaleSection.own) || firstSaid(rationaleSection.full) : "";
  const upper = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  let why = because ? upper(because) : rationaleSaid || contextSaid || "";
  let whySource = because ? "decision" : rationaleSaid ? "rationale" : contextSaid ? "context" : null;
  if (!why) {
    const inline = statement.match(/\b(?:because|so that|in order to)\b[\s\S]+$/i);
    if (inline && inline[0].length > 16) { why = upper(inline[0]); whySource = "decision"; }
  }
  const whyCap = capAtSentence(why);

  // Supporting points, each in the author's words and labelled by the section it came from.
  const points = [];
  let pointsFound = 0;
  const add = (type, s, extra) => {
    const t = capAtSentence(s, 320).text;
    if (!t || t.length < 3) return;
    if (points.some((p) => p.type === type && p.statement === t)) return;
    pointsFound++;
    if (points.length < MAX_POINTS) points.push({ type, statement: t, ...(extra || {}) });
  };
  if (whySource !== "context" && contextSaid) add("context", contextSaid);
  for (const s of all("drivers")) for (const b of readBullets(s.full)) add("constraint", b);
  // Options weighed: the bullets of the options section, else the sub-headings of the pros and cons.
  const options = [];
  for (const s of all("options")) for (const b of readBullets(s.own)) options.push(b);
  if (!options.length) for (const s of all("proscons").concat(all("options"))) for (const sub of sections) if (sub.line > s.line && sub.line < s.end && sub.level > s.level) options.push(sub.heading);
  const norm = (s) => plain(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const chosenKey = chosen ? norm(chosen) : null;
  const isChosen = (o) => {
    if (!chosenKey) return false;
    const k = norm(o.split(/\s[\u2013\u2014-]\s|:\s/)[0]);
    return !!k && (chosenKey === k || chosenKey.includes(k) || k.includes(chosenKey));
  };
  // What the record says against an option, where it weighs each one under its own heading ("Bad, because ...").
  const against = new Map();
  for (const s of all("proscons").concat(all("options"))) {
    for (const sub of sections) {
      if (!(sub.line > s.line && sub.line < s.end && sub.level > s.level)) continue;
      const bad = readBullets(sub.own).map((b) => (b.match(/^(?:bad|con|cons|negative|downside)\b[\s,:\u2013\u2014-]*(?:because\s+)?(.+)$/i) || [])[1]).find(Boolean);
      if (bad) against.set(norm(sub.heading), bad.trim());
    }
  }
  for (const o of options) {
    if (isChosen(o)) continue;
    const because = against.get(norm(o)) || against.get(norm(o.split(/\s[\u2013\u2014-]\s|:\s/)[0]));
    add(chosenKey ? "rejected_alternative" : "option_weighed", o, because ? { because: capAtSentence(because, 320).text } : null);
  }
  const consequenceSections = all("consequences");
  for (const s of consequenceSections) {
    const polarity = /^(?:positive|good|pros?)\b/i.test(s.heading) ? "positive" : /^(?:negative|bad|cons?|risks?)\b/i.test(s.heading) ? "negative" : null;
    const bullets = readBullets(s.own);
    for (const b of bullets.length ? bullets : readParagraphs(s.own).slice(0, 4)) add("consequence", b, polarity ? { polarity } : null);
  }

  const hasParts = !!(statusText || decisionSection || contextSection || consequenceSections.length);
  // PROOF THAT THIS IS A DECISION RECORD and not another kind of document that shares a heading with one. An
  // incident report has "Recommendations" and "Impact", a guide has "Background" and "Problem", and each of
  // those is a part a record can have. What only a record has is a status that reads as one, or a part
  // whose own heading says a decision was made. A folder named for records does not need this; any other
  // folder does (index.js), because there the file's own words are the only evidence there is.
  const saysDecided = sections.some((s) => /^(?:the\s+)?decisions?\b|^decided\b|^chosen\s+(?:option|alternative|solution)\b/i.test(s.heading)) || /^chosen\s+(?:option|alternative|solution)s?\b/i.test(statement);
  const proven = (state !== "unknown" && state !== "template") || saysDecided;
  const baseName = (String(file).split(/[\\/]/).pop() || "").replace(/\.[A-Za-z]+$/, "");
  // A file named like a template is one only when it has no status of its own: some folders keep a real record about their template.
  const settledState = ["accepted", "superseded", "partly_superseded", "deprecated", "rejected"].includes(state);
  const templateName = /^(?:adr[-_ ]?)?\d*[-_ ]?(?:adr[-_ ])?(?:(?:short|long|minimal|bare|basic|full)[-_ ])?templates?(?:[-_ ](?:short|long|minimal|bare|basic|full|madr|nygard))*$/i.test(baseName) && !settledState;
  const PLACEHOLDER = /\{(?:short )?title|\{describe|\{option|\{decision|\{context|\{justification|\{name|\{yyyy|\[short title|\[describe |\[option \d|title of solved problem|^<[a-z ]+>$|^\{[^}]*\}$/im;
  // A record can keep a template's leftovers: its title never filled in, or its outcome still a placeholder. With a
  // status of its own it is still a record, named by its file, and the placeholder is not passed on as its words.
  const titleIsPlaceholder = PLACEHOLDER.test(plain(titleRaw));
  const statementIsPlaceholder = PLACEHOLDER.test(statement) || PLACEHOLDER.test(because || "");
  const hasOwnStatus = state !== "template" && state !== "unknown";
  const templateBody = (titleIsPlaceholder && (statementIsPlaceholder || !statement) && !hasOwnStatus) || (titleIsPlaceholder && !hasOwnStatus) || (state === "template" && !decisionSection && !contextSection);
  const namedLikeRecord = name.number != null || !!name.date;
  const kind = templateName || templateBody ? "template" : title && hasParts ? "adr" : title && namedLikeRecord ? "adr" : "other";
  const fromFile = name.slug.replace(/[-_]+/g, " ").trim();
  const shownTitle = titleIsPlaceholder && fromFile ? fromFile.charAt(0).toUpperCase() + fromFile.slice(1) : title;

  const form = fm.status != null || fm["decision-makers"] != null || fm.deciders != null
    ? "madr front matter"
    : /^chosen\s+option/i.test(statement) || first("drivers") || all("options").length
      ? "madr"
      : name.date && pairs.status
        ? "log4brains"
        : first("changelog") && /^adr[\s-]*\d/i.test(plain(titleRaw))
          ? "cosmos"
          : statusSection && (contextSection || decisionSection)
            ? "nygard"
            : pairs.status
              ? "header lines"
              : "other";

  return {
    kind,
    file: String(file),
    form,
    number,
    titleNumber,
    title: shownTitle,
    weak: !hasParts,
    proven,
    status: { raw: plain(statusText).replace(/\s+/g, " ").slice(0, 300), state: state === "template" ? "unknown" : state, understood: state !== "unknown" && state !== "template" },
    date,
    dateSource,
    deciders,
    tags,
    statement: statementIsPlaceholder ? "" : statementCap.text,
    statementCut: statementCap.cut,
    why: statementIsPlaceholder && whySource === "decision" ? (contextSaid ? capAtSentence(contextSaid).text : null) : whyCap.text || null,
    whySource,
    whyCut: whyCap.cut,
    chosen,
    points,
    pointsLeftOut: Math.max(0, pointsFound - points.length),
    relations,
    has: { status: !!statusText, decision: !!decisionSection, context: !!contextSection, consequences: consequenceSections.length > 0 },
    // Line numbers count from 1 and include both ends, so a decision can be tied back to where it was read from.
    lines: {
      file: [1, original.split("\n").length - (original.endsWith("\n") ? 1 : 0) || 1],
      decision: decisionSection ? span(decisionSection, lines) : null,
      context: contextSection ? span(contextSection, lines) : null,
    },
    text: { decision: decisionSection ? decisionSection.full.trim() : "", context: contextSection ? contextSection.full.trim() : "", consequences: consequenceSections.map((s) => s.full.trim()).filter(Boolean).join("\n\n") },
    digest,
  };
}

module.exports = { parseAdr, readDate, readState, readRelations, readTargets, readFrontMatter, readFileName, splitTitle, headingKey, plain, capAtSentence, MAX_TEXT, MAX_POINTS };
