"use strict";
/*
 * npx unlimitless terminal — the Unl terminal, in a terminal.
 *
 * The same record the portal's Unl terminal streams: Unl's side of each turn, per agent, as it leaves.
 * It reads GET /api/serve-log with this machine's key (the key IS the workspace), every POLL_MS, and
 * prints each new serve once, in the shape Claude Code prints its own steps. Read-only: nothing here
 * edits a decision, and no word of a conversation exists to print (the log never kept one).
 *
 * SPECIFIC, NOT VAGUE: each kept decision by title with its one-line why, the count
 * weighed/kept/held, the held ones dimmed with the reason they were held, the heads-up's own text, the
 * changes by name (or no line), every receiver in plain words, and the same turn again as one line.
 *
 *   terminal                 every AI
 *   terminal --agent <id>    one run, seat or surface
 */

const POLL_MS = 2000;
/** What an empty terminal says. tui.js re-exports it, so the two views say the same thing. */
const EMPTY_TEXT = "Nothing served yet. Open Claude Code in a project and work as normal; your decisions will appear here as Unl serves them.";
const PAGE = 50;

const SURFACE = {
  "claude-code": "Claude Code", "claude.ai": "Claude", claude: "Claude", chatgpt: "ChatGPT", cursor: "Cursor",
  codex: "Codex", windsurf: "Devin Desktop", cline: "Cline", "ai-sdk": "AI SDK", hook: "a coding agent", api: "the API", mcp: "a connected AI",
};

/**
 * Unl's cyan for the accent, never Claude's orange, a set light grey for secondary text
 * rather than the terminal's faint "dim", and the flip: near-black on the accent, where Unl
 * added value.
 */
function paint(on) {
  const w = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { clay: w("38;5;81"), dim: w("38;5;250"), bold: w("1"), flip: on ? w("48;5;81;38;5;16;1") : (s) => String(s) };
}

/** The readable view the server sends; against an older server the same rules run here. */
const BACKGROUND_RX = /^\s*(?:<\s*(?:task-notification|system-reminder|local-command|command-name|command-message|bash-|tool_result|user-prompt-submit-hook)|\[SYSTEM NOTIFICATION|Stop hook feedback:)/i;
function viewOf(s) {
  if (s.view) return s.view;
  const t = typeof s.turn === "string" ? s.turn : "";
  const background = BACKGROUND_RX.test(t);
  const tail = String(s.agent || "").split(/[-_:]/).filter(Boolean).pop();
  return {
    background,
    said: background || !t ? null : t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null,
    source: s.agent ? (/^seat/i.test(s.agent) ? `seat ${tail}` : s.agent) : whoOf(s),
    heads: Array.isArray(s.heads_up) ? s.heads_up : [],
    changes: Array.isArray(s.changes) ? s.changes : [],
    lead: null,
  };
}

/**
 * ASCII FOR A FONT WITHOUT THE GLYPHS. The terminal draws with ⏺ ⎿ ✻ and box lines.
 * Windows Terminal, macOS, and Linux desktop terminals have fonts with them; the old Windows console
 * (conhost, which PowerShell and cmd open in when Windows Terminal is not the default) and the Linux
 * text console do not, and print boxes or question marks. There, each glyph becomes one ASCII
 * character, so every width is kept. UNL_ASCII=1 forces it anywhere; UNL_ASCII=0 turns it off.
 */
const GLYPH_ASCII = { "“": '"', "”": '"', "▌": "|", "⏺": "*", "✻": "*", "●": "*", "○": "o", "⎿": "`", "›": ">", "▸": ">", "─": "-", "│": "|", "┬": "+", "↑": "^", "↓": "v", "…": ".", "·": "-" };
const GLYPH_RX = new RegExp(`[${Object.keys(GLYPH_ASCII).join("")}]`, "g");
/** Unl's own glyphs as ASCII, one for one. Text that is not Unl's glyphs is left alone. Pure. */
const asciiOf = (s) => String(s).replace(GLYPH_RX, (g) => GLYPH_ASCII[g]);
/** Does this terminal want ASCII? Pure. */
function wantsAscii(env = process.env, platform = process.platform) {
  if (env.UNL_ASCII === "1") return true;
  if (env.UNL_ASCII === "0") return false;
  if (env.TERM === "linux") return true;
  // Windows: the old console is the one without the glyphs. Windows Terminal says so (WT_SESSION), and so
  // do VS Code's, ConEmu's and the terminals that set TERM_PROGRAM or TERM (mintty, Alacritty, WezTerm).
  if (platform === "win32") return !(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === "ON" || env.TERM);
  return false;
}

const KEPT_SHOWN = 5;
const HELD_SHOWN = 3;
const CHANGES_SHOWN = 3;

/** A serve's identity for de-duplication: the log row has no id over the API, so time + receiver + conversation. */
const keyOf = (s) => `${s.at}|${s.agent || ""}|${s.surface || s.channel || ""}|${s.conversation || ""}`;

function hhmmss(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toTimeString().slice(0, 8);
}

/** The receiver in plain words: the API names it (label); an older server did not, so fall back. */
const whoOf = (s) => s.label || SURFACE[String(s.surface || s.channel || "").toLowerCase()] || s.surface || s.channel || "an AI";

/**
 * Unl's answer in its own voice, for a server that does not send one yet: the same rule as the server's
 * unlVoice. The strongest decision that is not a standing
 * rule, by title with its why; a count of the rest; a plain line when nothing bore. Pure.
 */
function voiceOf(decisions, heads) {
  const bearing = (Array.isArray(decisions) ? decisions : []).filter((d) => !d.standing);
  const top = bearing[0];
  if (!top) return heads && heads.length ? "Nothing you've decided bears on this, but something changed that you should hear about." : "Nothing you've decided bears on this.";
  const words = String(top.title || "one of your decisions").split(/\s[\u2014\u2013-]\s|:\s/)[0].split(/\s+/).filter(Boolean);
  const title = words.length > 5 ? `${words.slice(0, 5).join(" ")}\u2026` : words.join(" ");
  // The server's voiceWhy rule: no shouted lead-in label, and an ellipsis takes no full stop after it.
  const w0 = top.why ? String(top.why) : "";
  const w1 = (w0.replace(/^(?:[A-Z][A-Z0-9'\u2019\-]*\s+){1,7}[A-Z][A-Z0-9'\u2019\-]*:\s+/, "").trim() || w0).replace(/[.!]$/, "");
  const why = w1 ? `: ${w1[0].toUpperCase()}${w1.slice(1)}` : "";
  const rest = bearing.length - 1;
  const more = rest ? ` ${rest === 1 ? "One more of your decisions bears on it too." : `${rest} more of your decisions bear on it too.`}` : "";
  return `\u201c${title}\u201d bears on this${why}${why.endsWith("\u2026") ? "" : "."}${more}`;
}

/** The speaker column of the exchange: room for "Claude Code then". */
const VOICE_W = 16;
const voiceLabel = (t) => String(t).padEnd(VOICE_W).slice(0, VOICE_W);

/**
 * What the AI did after a turn, as lines: the first under the AI's name ("Claude Code
 * then"), a moment (a stop for the person, a sealed decision) in the accent's type. `first` says
 * whether these print with their turn; later ones print on their own as they arrive, under a line naming
 * the turn they follow. Pure.
 */
function actLines(s, acts, first, color = false) {
  const c = paint(color);
  const out = first ? [] : [c.dim(`  ⎿  later, after the ${hhmmss(s.at)} turn`)];
  acts.forEach((a, i) => {
    const label = c.dim(voiceLabel(i === 0 ? `${whoOf(s)} then` : ""));
    // Round two: an act that names a decision Unl handed over says which: Unl changed its course.
    const line = a.because ? `${a.line} · acting on \u201c${a.because}\u201d` : a.line;
    out.push(a.moment ? `  ${label} ${c.clay(c.bold(line))}` : `  ${label} ${line}`);
  });
  return out;
}

/**
 * Unl's reply to a turn already printed: it is written a moment after the serve, so it prints under
 * a line naming the turn it answers, with what each [n] opens. Pure.
 */
function lateVoiceLines(s, color = false) {
  const c = paint(color);
  const v = viewOf(s);
  const src = Array.isArray(v.sources) ? v.sources : [];
  return [
    c.dim(`  ⎿  a moment later, on the ${hhmmss(s.at)} turn`),
    `  ${c.clay(voiceLabel("Unl"))} ${c.bold(String(v.answer))}`,
    ...(src.length ? [c.dim(`  ⎿  ${src.map((x) => `[${x.n}] ${x.title || "a decision"}`).join(" · ")}`)] : []),
  ];
}

/** One serve as terminal lines, led by what Unl did for the person. Pure, so the shape is tested without a network. */
function renderServe(s, color = false) {
  const c = paint(color);
  const v = viewOf(s);
  const decisions = Array.isArray(s.decisions) ? s.decisions : [];
  const heldList = Array.isArray(s.held) ? s.held : Array.isArray(s.held_back) ? s.held_back.map((id) => ({ id })) : [];
  const heldN = heldList.length || Number(s.held_back) || 0;
  const heads = Array.isArray(v.heads) ? v.heads : [];
  const changes = Array.isArray(v.changes) ? v.changes : [];
  const handed = decisions.length > 0;
  const n = decisions.length;
  const lines = [];
  const src = s.agent ? c.dim(` · ${v.source || s.agent}`) : "";
  lines.push(`${handed ? c.clay("⏺") : c.dim("⏺")} ${c.bold(whoOf(s))}${s.model ? c.dim(` · ${s.model}`) : ""}${src}  ${c.dim(hhmmss(s.at))}`);
  const under = s.greater && s.greater.title ? String(s.greater.title).split(/\s[—–-]\s|:\s/)[0] : "";
  const lead = v.lead || (!n ? "Nothing you decided bore on this, so Unl stayed quiet" : `Gave ${whoOf(s)} ${n === 1 ? "one of your decisions" : `${n} of your decisions`}${under ? ` under ${under}` : ""}`);
  // Which project Agent Unl read the turn as, so a miss is visible. Absent with one project.
  if (s.read) lines.push(`  ${c.dim("⎿")}  ${c.dim("read as")} ${String(s.read)}`);
  // THE TURN AS A CONVERSATION BETWEEN TWO AIS: the AI asks, Unl answers with what bore and
  // why, the moments stand out, and what the AI did next follows as it is reported (actLines). The decision
  // list sits beneath, compact, with the standing rules folded into one line.
  // ROUND THREE: a surface's own description of the turn is a quiet line about it,
  // never the AI speaking; and (d) when nothing bore, Unl's line stays, but quiet.
  if (v.context) lines.push(c.dim(`  ⎿  about ${String(v.context).slice(0, 240)}`));
  if (v.said) lines.push(`  ${c.dim(voiceLabel(whoOf(s)))} ${String(v.said).slice(0, 240)}`);
  const unlSays = v.answer || (v.lead && !decisions.length ? v.lead : voiceOf(decisions, heads));
  lines.push(`  ${c.clay(voiceLabel("Unl"))} ${v.quiet ? c.dim(unlSays) : c.bold(unlSays)}`);
  for (const h of heads) lines.push(`  ${voiceLabel("")} ${c.clay("heads-up")} ${c.clay(String(h).replace(/^★\s*/, ""))}`);
  lines.push(...actLines(s, Array.isArray(v.acts) ? v.acts : [], true, color));
  // ROUND TWO: when Unl answered in its own words, the decisions it cites are one
  // line (what each [n] opens) and the whole list is one more; the full-screen terminal opens it.
  if (v.answer_by === "unl" && v.answer) {
    const src = Array.isArray(v.sources) ? v.sources : [];
    if (src.length) lines.push(c.dim(`  ⎿  ${src.map((x) => `[${x.n}] ${x.title || "a decision"}`).join(" · ")}`));
    if (v.list_line) lines.push(c.dim(`  ⎿  ${v.list_line} · the full-screen terminal lists them`));
    for (const ch of changes.slice(0, CHANGES_SHOWN)) lines.push(c.dim(`  ⎿  changed ${ch}`));
    if (changes.length > CHANGES_SHOWN) lines.push(c.dim(`  ⎿  +${changes.length - CHANGES_SHOWN} more changes`));
    return lines;
  }
  // A decision the conversation's previous turn already handed over folds to one line, not repeated.
  const bearingAll = decisions.filter((d) => !d.standing);
  const bearing = bearingAll.filter((d) => !d.again);
  const again = bearingAll.length - bearing.length;
  const standing = decisions.length - bearingAll.length;
  // The strongest's why is in Unl's answer above; the rest keep theirs here.
  bearing.slice(0, KEPT_SHOWN).forEach((d, i) => lines.push(`     ${i === 0 ? c.flip(` ✻ ${d.title || "A decision"} `) : c.clay(` ✻ ${d.title || "A decision"}`)}${i > 0 && d.why ? c.dim(` ${d.why}`) : ""}`));
  if (bearing.length > KEPT_SHOWN) lines.push(c.dim(`     +${bearing.length - KEPT_SHOWN} more kept`));
  if (again) lines.push(c.dim(`  ⎿  + ${again} again from the last turn`));
  if (standing) lines.push(c.dim(`  ⎿  + ${standing} of your decisions that ${standing === 1 ? "applies" : "apply"} to every turn · the full-screen terminal lists them`));
  // Held decisions are one line; their reasons are one key away, never a wall under one kept decision.
  if (heldN) lines.push(c.dim(`  ⎿  Held back ${heldN}: not about this · the full-screen terminal shows why (h)`));
  for (const ch of changes.slice(0, CHANGES_SHOWN)) lines.push(c.dim(`  ⎿  changed ${ch}`));
  if (changes.length > CHANGES_SHOWN) lines.push(c.dim(`  ⎿  +${changes.length - CHANGES_SHOWN} more changes`));
  return lines;
}

/** The one quiet line a run of background updates prints as (a task notification, a monitor event). Pure. */
function renderBackground(source, n, from, to, color = false) {
  const c = paint(color);
  return [c.dim(`  ▸ ${n} background update${n === 1 ? "" : "s"} from ${source} · ${hhmmss(from)}${n > 1 ? ` to ${hhmmss(to)}` : ""}`)];
}

/** The one line a repeat prints instead of the whole block: the same turn again, counted. Pure. */
function renderRepeat(s, times, color = false) {
  const c = paint(color);
  return [c.dim(`  ⎿  the same turn again (${times} in a row) · ${hhmmss(s.at)}`)];
}

/**
 * Of a newest-first page, the serves not yet printed, oldest first. Pure. `seen` is mutated so each serve
 * prints once across polls.
 */
function freshServes(page, seen) {
  const out = [];
  for (const s of [...(Array.isArray(page) ? page : [])].reverse()) {
    const k = keyOf(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

async function runTerminal({ api, key, agent, say: sayRaw, color, self = "unl", fetchImpl = fetch, once = false, ascii = wantsAscii() }) {
  const say = ascii ? (t) => sayRaw(asciiOf(t)) : sayRaw;
  const c = paint(color);
  const seen = new Set();
  const actsSeen = new Map();
  // Unl's reply is written after its turn: a turn printed without one prints it once when it lands.
  const voiced = new Set();
  const q = `?limit=${PAGE}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`;
  say(`${c.clay("✻")} ${c.bold("Unl terminal")} ${c.dim(`· watching ${agent || "every AI"} · what your AI sends Unl is kept in your workspace, secrets stripped · ctrl-c to leave`)}\n`);
  let quietSaid = false;
  let faultSaid = false;
  let lastSig = null;
  let runLen = 0;
  // Background updates from one source are held and printed as one line when something else arrives.
  let bg = null;
  const flushBg = () => { if (bg) { say(renderBackground(bg.source, bg.n, bg.from, bg.to, color).join("\n") + "\n"); bg = null; } };
  for (;;) {
    try {
      const res = await fetchImpl(`${api}/api/serve-log${q}`, { headers: { authorization: `Bearer ${key}`, "user-agent": "unl-terminal/0.1" } });
      if (res.status === 401) throw Object.assign(new Error(`This machine's key was not accepted (revoked?). Run \`${self}\` to sign in again.`), { fatal: true });
      if (!res.ok) throw new Error(`Unl answered HTTP ${res.status}`);
      const body = await res.json();
      // Acts reported after a turn already printed print on their own, once each.
      for (const s of Array.isArray(body.serves) ? body.serves : []) {
        const k = keyOf(s);
        if (!seen.has(k)) continue;
        const acts = Array.isArray(s.view && s.view.acts) ? s.view.acts : [];
        const done = actsSeen.get(k) || new Set();
        const late = acts.filter((a) => !done.has(a.key));
        if (!late.length) continue;
        for (const a of late) done.add(a.key);
        actsSeen.set(k, done);
        flushBg();
        say(actLines(s, late, false, color).join("\n") + "\n");
      }
      for (const s of Array.isArray(body.serves) ? body.serves : []) {
        const k = keyOf(s);
        const v = viewOf(s);
        if (!seen.has(k) || voiced.has(k) || v.answer_by !== "unl" || !v.answer) continue;
        voiced.add(k);
        flushBg();
        say(lateVoiceLines(s, color).join("\n") + "\n");
      }
      const fresh = freshServes(body.serves, seen);
      for (const s of fresh) {
        if (viewOf(s).answer_by === "unl") voiced.add(keyOf(s));
        actsSeen.set(keyOf(s), new Set((Array.isArray(s.view && s.view.acts) ? s.view.acts : []).map((a) => a.key)));
        const v = viewOf(s);
        if (v.background) {
          if (bg && bg.source !== v.source) flushBg();
          bg = bg ? { ...bg, n: bg.n + 1, to: s.at } : { source: v.source, n: 1, from: s.at, to: s.at };
          continue;
        }
        flushBg();
        // The same turn back to back is one line, never a wall of copies.
        if (s.sig && s.sig === lastSig) { runLen += 1; say(renderRepeat(s, runLen, color).join("\n") + "\n"); continue; }
        lastSig = s.sig || null;
        runLen = 1;
        say(renderServe(s, color).join("\n") + "\n");
      }
      if (!seen.size && !quietSaid) { say(c.dim(`  ${EMPTY_TEXT}\n`)); quietSaid = true; }
      if (faultSaid) { say(c.dim("  Reconnected.\n")); faultSaid = false; }
    } catch (err) {
      if (err && err.fatal) throw err;
      // A fault is said once, never passed off as a quiet Unl, and the terminal keeps trying.
      if (!faultSaid) { say(c.dim(`  Cannot reach Unl (${err && err.message ? err.message : err}). Retrying.\n`)); faultSaid = true; }
    }
    if (once) { flushBg(); return seen.size; }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

module.exports = { EMPTY_TEXT, runTerminal, actLines, lateVoiceLines, voiceOf, asciiOf, wantsAscii, GLYPH_ASCII, renderServe, renderRepeat, renderBackground, freshServes, keyOf, viewOf, POLL_MS };
