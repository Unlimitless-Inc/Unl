"use strict";
/*
 * Choosing what reaches the agent: the wide net, then the judge, then what is never dropped.
 *
 * One function, used by the hook and by `unl serve`, so what a person is shown is what an agent gets.
 *
 *   1. serve.forJudge casts the wide net (no model).
 *   2. The judge, the person's own model, sorts it into what bears and what might (judge.js).
 *   3. What the words and the place are SURE of is added back if the judge left it out, as one line.
 *      A judge may shorten a sure match. It may not drop one, so switching the judge on can never
 *      reach fewer of the decisions that bear than the sure matches did by themselves.
 *
 * What comes back says how it was chosen, because a reading of the serve has to know:
 *   path "judge"   the judge answered: `full` and `held` are its choice plus the sure matches
 *   path "net"     the judge was asked and could not answer (`fault` says why), or had already failed
 *                  this turn: `full` is what the words and the place are sure of, and `held` is the top
 *                  of the wide net, one line each
 *   path "words"   nobody was asked and nothing is down: the person switched the judge off (`off` is
 *                  true), this agent is not asked at this moment, or what was typed is not an ask.
 *                  `full` is what the words of the ask and the place of the file find
 *
 * WHEN THE JUDGE IS DOWN the agent gets less, never the whole record, and what might
 * bear is still one step away. How wide "less" is was measured by the gate on 800 pieces
 * of real work with the whole message as the ask. The sure matches alone reached 20 of the 358 decisions
 * that bore. Words in common reached 72. The top 8 of the wide net at each call reached 228, and the whole
 * net 242. A decision that bears and is left out is the failure to avoid, so on a fault the net is handed,
 * cut at 8 and shortened to a line each. What that costs is silence while the judge is down, which is why
 * the person is told once that it is.
 *
 * WHEN THE PERSON HAS SWITCHED THE JUDGE OFF nothing is down. They chose the quieter serve, and get what
 * the words and the place find.
 */
const serve = require("./serve");
const judge = require("./judge");

const isFile = (work) => !!work.path;
const how = (h) => (h.kind === "names" || h.kind === "words" || h.kind === "candidate" ? h.kind : h.what || h.kind);

/** What the words of the ask, or the place and content of the file, find with no model. Crossings are the caller's. */
function byWords(index, work, { seen, profile }) {
  const hits = isFile(work) ? serve.forAction(index, { path: work.path, content: work.content }, { seen, profile }) : serve.forPrompt(index, work.prompt, { seen, profile });
  return hits.filter((h) => h.kind !== "crossing").map((h) => ({ ...h, form: "full", by: how(h) }));
}

/** What is handed when the judge is down: the sure matches in full, and the top of the wide net as one line each. */
function byNet(index, work, { seen, profile }) {
  const full = serve.sureFor(index, work, { seen }).slice(0, profile.maxFull).map((h) => ({ ...h, form: "full", by: how(h) }));
  const have = new Set(full.map((h) => h.entry.id));
  const held = serve.candidates(index, work, { limit: Infinity })
    .filter((c) => !seen.has(c.entry.id) && !have.has(c.entry.id))
    .slice(0, profile.maxNet)
    .map((c) => ({ ...c, form: "held", by: "net" }));
  return { full, held };
}

/**
 * Choose for one piece of work: `{ prompt }` at the ask, or `{ prompt, path, content }` before a file changes.
 * `skipJudge` is "after-fault" when the judge has already failed this turn (or three times running), and
 * "not-an-ask" when what was typed is an answer or a word or two. Resolves to
 * { path, full, held, left, call, fault, off }. Never rejects.
 */
async function choose(index, work, { host = "claude", seen = new Set(), env = process.env, profile = serve.PROFILE, skipJudge = null } = {}) {
  const none = { path: "words", full: [], held: [], left: [], call: null, fault: null, off: false };
  if (!index || !index.count) return none;
  const cfg = judge.config(index, env);
  if (cfg.mode !== "on") return { ...none, off: true, full: byWords(index, work, { seen, profile }) };
  if (skipJudge === "after-fault") return { ...none, path: "net", ...byNet(index, work, { seen, profile }) };
  // Not every agent is asked, and not at every moment: one that is too slow to answer inside a hook is
  // left out there (judge.js says which, as measured). That is not a fault, so none is written down.
  const limit = judge.limitFor(host, isFile(work));
  if (skipJudge || !limit) return { ...none, full: byWords(index, work, { seen, profile }) };

  const list = serve.forJudge(index, work, { seen, profile });
  if (!list.length) return { ...none, path: "judge" };
  const res = await judge.judge(host, list.map((c) => c.entry), work, { model: cfg.model, env, timeoutMs: limit });
  if (!res.ok) return { ...none, path: "net", ...byNet(index, work, { seen, profile }), fault: { reason: res.reason, detail: res.detail || "", ms: res.ms || 0 } };

  const caught = new Map(list.map((c) => [c.entry.id, c]));
  const as = (entry, form, by) => ({ entry, kind: "judge", matched: (caught.get(entry.id) || { matched: [] }).matched, form, by });
  let full = res.hand.map((e) => as(e, "full", "judge"));
  let held = res.hold.map((e) => as(e, "held", "judge"));
  const have = new Set([...full, ...held].map((h) => h.entry.id));
  // What the words and the place are sure of is never dropped by a judge, only shortened to a line.
  for (const h of serve.sureFor(index, work, { seen })) if (!have.has(h.entry.id)) { held.push({ ...h, form: "held", by: how(h) }); have.add(h.entry.id); }
  // More in full than the profile allows is shortened, never dropped; one-liners past their own limit are.
  if (full.length > profile.maxFull) { held = [...full.slice(profile.maxFull).map((h) => ({ ...h, form: "held" })), ...held]; full = full.slice(0, profile.maxFull); }
  held = held.slice(0, profile.maxHeld);
  const handed = new Set([...full, ...held].map((h) => h.entry.id));
  return {
    ...none, path: "judge", full, held, left: list.filter((c) => !handed.has(c.entry.id)),
    call: res.asked ? { ms: res.ms, tokens_in: res.tokens_in, tokens_out: res.tokens_out, model: res.model, candidates: list.length } : null,
  };
}

module.exports = { choose, byWords, byNet };
