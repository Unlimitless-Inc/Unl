"use strict";
/*
 * Words, for matching. Deterministic and small on purpose: no model, no network, the same answer
 * every time for the same text. Where a model's judgment would do better, the place to add it is
 * named in serve.js; nothing here pretends to be one.
 */
const STOP = new Set(("a an and are as at be been but by can could did do does doing done for from had has have having he her here hers him his how i if in into is it its just me more most my no nor not of off on once only or other our ours out over own same she should so some such than that the their theirs them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours " +
  "also any each every all both few many much about above after again against am because before below between down during further get got make made use used using need needs want wants like please thanks").split(/\s+/));

/** A light stemmer: enough that "exports", "exported" and "exporting" meet. Not linguistics. */
function stem(w) {
  if (w.length <= 3) return w;
  let s = w;
  if (s.endsWith("ies") && s.length > 4) s = s.slice(0, -3) + "y";
  else if (s.endsWith("sses")) s = s.slice(0, -2);
  else if (s.endsWith("es") && s.length > 4 && /(ch|sh|x|z|s)es$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith("s") && !s.endsWith("ss") && !s.endsWith("us") && !s.endsWith("is")) s = s.slice(0, -1);
  if (s.endsWith("ing") && s.length > 5) s = s.slice(0, -3);
  else if (s.endsWith("ed") && s.length > 4) s = s.slice(0, -2);
  if (s.length > 3 && s[s.length - 1] === s[s.length - 2] && !/[aeiouls]$/.test(s)) s = s.slice(0, -1);
  if (s.endsWith("e") && s.length > 4) s = s.slice(0, -1);
  return s;
}

/** Split text into matchable words: lowercased, camelCase and snake_case opened up, stop words dropped, stemmed. */
function words(text) {
  const out = [];
  const raw = String(text || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/);
  for (let w of raw) {
    w = w.replace(/^[.]+|[.]+$/g, "");
    if (!w) continue;
    for (const part of w.includes(".") ? [w, ...w.split(".")] : [w]) {
      if (part.length < 2 || STOP.has(part) || /^\d+$/.test(part)) continue;
      // A dotted name (schema.ts, package.json) is matched whole and by its parts, never stemmed.
      out.push(part.includes(".") ? part : stem(part));
    }
  }
  return out;
}

/** Word counts for one text. */
function counts(text) {
  const m = new Map();
  for (const w of words(text)) m.set(w, (m.get(w) || 0) + 1);
  return m;
}

/** Collapse whitespace and trim: the form two pieces of text are compared in. */
const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();

/** A short, stable, readable identifier from a title. */
function slug(s, max = 48) {
  const t = String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (t.slice(0, max).replace(/-+$/g, "") || "decision");
}

module.exports = { words, counts, stem, squash, slug, STOP };
