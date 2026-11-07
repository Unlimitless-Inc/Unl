"use strict";
/*
 * Hearing a decision being made.
 *
 * People decide things mid-conversation: "no, we never do that here", "from now on use the queue".
 * Then they repeat it next week to an agent that was never told. This file recognises three moments in
 * what the person types, and only in what the person types:
 *
 *   standing   they have just stated something that sounds like a standing decision
 *   answer     they have just said yes or no to keeping one
 *   restated   they have just re-explained something that is already kept
 *
 * Deterministic and cautious. Asking too often is worse than missing one, because a person who is
 * asked about every sentence turns the thing off. So the phrases below are the ones people use for
 * rules, not the ones they use for today's task ("don't touch the tests" is about today).
 */
const { words, squash } = require("./text");

const STANDING = [
  /\b(from now on|going forward|in future|in the future|as a rule|as a policy|by default|for future reference)\b/i,
  /\b(we|i)\s+(always|never|don't ever|do not ever)\b/i,
  /(^|[.!?]\s+|,\s*|\bplease\s+)(always|never)\s+[a-z`]/i,
  /\b(don't|do not|never)\s+ever\b/i,
  /\bin this (repo|repository|project|codebase|app|service)[, ]+(we|always|never|use|don't|do not)\b/i,
  /\b(our|the) (convention|rule|policy|standard) (is|here is)\b/i,
  /\bwe (use|prefer|don't use|do not use|stopped using|no longer use|moved to|switched to|standardi[sz]ed on)\b/i,
  /\bremember (that|to|this)\b/i,
  /\b(stop|quit) (using|doing|adding|writing)\b/i,
];

/** Text that is not the person talking: pasted material, tool output, system notices. Never read as a decision. */
const NOT_THE_PERSON = /<pasted_content|<task-notification|<system-reminder|<tool_result|\[SYSTEM NOTIFICATION|^\s*```/im;

/** The sentence in which the person stated a standing decision, or null. */
function standing(prompt) {
  const text = String(prompt || "");
  if (!text.trim() || text.length > 1500 || NOT_THE_PERSON.test(text)) return null;
  for (const s of text.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = squash(s);
    if (sentence.length < 12 || sentence.length > 320 || /\?$/.test(sentence)) continue;
    if (STANDING.some((re) => re.test(sentence))) return sentence;
  }
  return null;
}

const YES = /^\s*(yes|yep|yeah|yup|y|sure|ok|okay|please do|do it|go ahead|keep(\s+(it|that|this|them))?)\b[\s,.!:;-]*/i;
const NO = /^\s*(no|nope|nah|n|skip|skip it|not now|leave it|don't|do not)\b/i;

/** The person's answer to "keep this?": { answer: "yes" | "no", rest } or null when this is not an answer. */
function answer(prompt) {
  const text = squash(prompt);
  // An answer is one short line. Several lines beginning with "yes" is far more often something pasted
  // (an email, a log) than a person answering Unl, and a pasted yes must never keep a decision.
  if (!text || text.length > 300 || /\n/.test(String(prompt).trim()) || NOT_THE_PERSON.test(String(prompt))) return null;
  const y = YES.exec(text);
  if (y) return { answer: "yes", rest: squash(text.slice(y[0].length)).replace(/^(because|since|as)\s+/i, "") };
  if (NO.test(text)) return { answer: "no", rest: "" };
  return null;
}

/**
 * Where an answer stops giving the reason and starts telling the agent what to do: "keep, pnpm was too
 * slow on CI. Do both." The reason is the first part; "Do both." is for the agent and is no part of why.
 * The first words get a narrower test, because a reason can begin with a verb ("run times doubled").
 */
const TO_THE_AGENT_FIRST = /^(?:please\s+)?(?:do (?:both|it|that|this|so|the rest)|go ahead|proceed|carry on|continue|thanks|thank you|cheers)\b/i;
const TO_THE_AGENT = /^(?:(?:and|so|then|now|also|ok|okay)\s+)*(?:please\s+)?(?:do|go|go ahead|proceed|continue|carry on|make|run|switch|change|update|apply|start|implement|install|migrate|move|add|remove|fix|let'?s|can you|could you|would you|you can|you should|thanks|thank you|cheers)\b/i;

/** The reason alone, from what followed the person's yes. Empty when all of it was for the agent. */
function reasonOf(rest) {
  const text = squash(rest);
  if (TO_THE_AGENT_FIRST.test(text)) return "";
  const at = /[.!?;]\s+|,\s*/g;
  let m;
  while ((m = at.exec(text))) {
    if (TO_THE_AGENT.test(text.slice(m.index + m[0].length))) return text.slice(0, m.index + (/^[.!?]/.test(m[0]) ? 1 : 0)).trim();
  }
  return text;
}

/** The reason a person gave inside the sentence that stated the decision ("…, because pnpm was slow"), or null. */
function reasonIn(sentence) {
  const m = /\b(?:because|since)\s+(.{3,})$/i.exec(squash(sentence));
  return m ? reasonOf(m[1]) || null : null;
}

/** Words that carry a rule's manner and not its content: "I told you", "here", "again". */
const LIGHT = new Set(["told", "tell", "said", "say", "here", "again", "alway", "pleas", "rememb", "now", "going", "forward", "future", "rule", "repo", "project", "codebas", "actually", "ever", "still", "already", "run", "thing", "stuff", "just", "really"]);
const NEG = /^(not|never|no|don't|dont|without|stop|avoid)$/;

/** The words that follow a "never" or a "not": what the sentence is against. */
function against(text) {
  const raw = String(text || "").toLowerCase().replace(/[`*_.,;:!?()]/g, " ").split(/\s+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i < raw.length; i++) if (NEG.test(raw[i])) for (const w of words(raw.slice(i + 1, i + 4).join(" "))) out.add(w);
  return out;
}

/** "Instead of pnpm", "rather than npm", "no longer use Jest", "switch from Yarn": what the sentence moves away from. */
const AWAY = /\b(?:instead of|rather than|in place of|no longer (?:use |using |do |doing )?|(?:switch|switched|switching|move|moved|moving|migrate|migrated|migrating) (?:over )?(?:away )?from|replac(?:e|es|ed|ing)|(?:stop|stopped|quit) using|drop(?:ped|ping)?)\s+(.{1,60}?)(?=$|[,.;:!?]|\s(?:to|with|for|because|since|as|and|but|so|now)\b)/gi;

function away(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(AWAY)) for (const w of words(m[1])) if (w.length >= 3 && !LIGHT.has(w)) out.add(w);
  return out;
}

/**
 * Does what the person just said touch a decision that is already kept? Two different answers:
 *
 *   same     they are re-explaining it. Nearly every word of the kept decision is there, nothing of
 *            substance was added, and it is against the same things.
 *   change   it is close to a kept decision but not the same: a word of substance differs, or it is
 *            now against something else. That reads as the decision changing.
 *
 * The line between them is drawn tightly on purpose. Telling an agent "the person re-affirmed X" when
 * they had in fact just changed X is the worst thing this could do, so anything short of plainly the
 * same is treated as a possible change and put to the person as a question.
 *
 * A sentence that moves away from something ("bun instead of pnpm") is a change to the decision that is
 * for that thing ("Use pnpm, never npm"), however few other words the two share. A decision already
 * against it ("Never use moment.js") is not changed by moving away from it.
 */
function touches(index, prompt) {
  const sentence = standing(prompt);
  if (!sentence || !index || !index.count) return null;
  const sw = new Set(words(sentence));
  if (sw.size < 3) return null;
  const gone = away(sentence);
  const b = against(sentence);
  let best = null;
  for (const e of index.decisions) {
    const dw = new Set(words(e.statement));
    if (dw.size < 2) continue;
    const a = against(e.statement);
    const leaving = [...dw].filter((w) => gone.has(w) && !a.has(w)).length;
    let shared = 0;
    for (const w of dw) if (sw.has(w)) shared++;
    if (!leaving && (shared < 2 || shared / Math.min(sw.size, dw.size) < 0.5)) continue;
    const missing = [...dw].filter((w) => !sw.has(w) && !LIGHT.has(w)).length;
    const extra = [...sw].filter((w) => !dw.has(w) && !LIGHT.has(w) && !NEG.test(w)).length;
    const sameSide = a.size === 0 && b.size === 0 ? true : a.size > 0 && b.size > 0 && [...a].some((w) => b.has(w));
    const same = !leaving && (missing === 0 || (missing <= 1 && dw.size >= 6)) && extra <= 2 && sameSide;
    const score = (leaving ? 1 + leaving / dw.size : 0) + shared / dw.size - (same ? 0 : 0.01);
    if (!best || score > best.score) best = { entry: e, kind: same ? "same" : "change", score, sentence };
  }
  return best;
}

/** Kept for callers that only want the plain case: the decision being re-explained, or null. */
function restated(index, prompt) {
  const t = touches(index, prompt);
  return t && t.kind === "same" ? t.entry : null;
}

module.exports = { standing, answer, reasonOf, reasonIn, restated, touches, against, away, STANDING, NOT_THE_PERSON };
