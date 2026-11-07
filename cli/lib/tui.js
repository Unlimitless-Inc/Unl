"use strict";
/*
 * The Unl terminal as a full-screen TUI (; Neil's design bar, momenta,
 *).
 *
 * "claude code looks good in the terminal, we should look good in the terminal". Designed for a full 16:9
 * terminal first: the stream on the left and the lit shelf as a quiet right-hand panel, the way Claude
 * Code keeps its "files changed" panel (one heading, a thin rule, a short list). Below SPLIT_MIN columns
 * the shelf folds inline under each turn; it resizes live. Unl's own actions are set in the flip: near-
 * black type on a band of the living accent, in 24-bit colour, with a 256-colour and a plain
 * fallback. The accent drifts slowly through its hues as it does on the site, never flashing.
 *
 * Read-only, like the line mode (terminal.js): it reads GET /api/serve-log with this machine's key and
 * prints what Unl knows, never a word of a conversation.
 *
 * The rendering is pure (frame() returns the rows), so every layout is tested without a terminal.
 */

// EMPTY_TEXT: what an empty terminal says, one string for both views so they never drift.
const { beatsFor } = require("./terminal-beats");
const { keyOf, asciiOf, wantsAscii, POLL_MS, EMPTY_TEXT, voiceOf } = require("./terminal");

/** At this many columns and wider the shelf is its own right-hand pane; narrower, it folds inline. */
const SPLIT_MIN = 120;
/** The shelf pane's width: about a third of the window, within these bounds. */
const SHELF_MIN = 40;
const SHELF_MAX = 60;
/**
 * UNL'S CYAN. The
 * accent rests on the logo's own cyan, #31E3F6 = hsl(186 92% 58%) (Neil 27 Sep: "closest
 * match to cyan in the logo"; read from web/public/logo.png, 24,869 pixels of exactly #31E3F6), and breathes a
 * little either way by hue, aqua-ward and sky-ward, one slow swing a minute, never orange.
 */
const HUE_CENTRE = 186;
const HUE_SWING = 14;
const HUE_PERIOD_S = 60;
const HUE_START = HUE_CENTRE;
/** The hue at t seconds: always within the blues. Pure. */
const hueAt = (t) => HUE_CENTRE + HUE_SWING * Math.sin((2 * Math.PI * t) / HUE_PERIOD_S);
/** How often the accent moves on screen. Slow enough never to flash, quick enough to feel alive. */
const DRIFT_MS = 500;
/** Lines of the turn shown until it is picked; picked, it shows whole. */
const TURN_LINES = 3;
/** Serves the stream keeps in memory. */
const KEEP = 200;

const ESC = "\x1b[";
const ON_ACC = [4, 17, 13]; // --on-acc #04110D: near-black that reads on the accent at every hue
/**
 * Secondary text, lighter not fainter (Neil: "the grey text doesnt work well, its too
 * faint"). The terminal's own "dim" attribute renders at whatever the theme makes it, often under 3:1; this
 * is a set grey, #b8b4ac, about 9:1 on a near-black ground.
 */
const SOFT = [184, 180, 172];
const INK = [7, 8, 10];
/**
 * CYAN IS UNL'S COLOUR (; Neil on 0.2.1: "bit more cyan
 * and this will be lovely"). The mark, the "Unl" chip, is this one cyan and never drifts: the site's
 * --unl-cyan, #31E3F6. The accent around it rests on cyan and breathes only a little either way.
 */
const UNL_CYAN = [49, 227, 246];

/** Which colour the terminal can show. Pure. */
function colorMode(env = process.env, isTTY = true) {
  if (!isTTY || env.NO_COLOR) return "plain";
  const ct = String(env.COLORTERM || "").toLowerCase();
  if (ct === "truecolor" || ct === "24bit") return "truecolor";
  // Terminals with 24-bit colour that do not set COLORTERM: Windows Terminal, and VS Code's and
  // Cursor's integrated terminals (which run Windows shells without COLORTERM).
  if (env.WT_SESSION || env.TERM_PROGRAM === "vscode") return "truecolor";
  if (/256/.test(String(env.TERM || "")) || env.TERM_PROGRAM === "Apple_Terminal") return "256";
  return String(env.TERM || "") === "dumb" ? "plain" : "256";
}

/** hsl → rgb, for the accent at a hue. Pure. */
function hsl(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
}
/** The accent at a hue: the logo cyan's own saturation and lightness, hsl(h 92% 58%); at rest it IS the logo's cyan. */
const accentAt = (h) => hsl(((h % 360) + 360) % 360, 92, 58);

/** Nearest xterm-256 colour cube index. Pure. */
function to256([r, g, b]) {
  const c = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  return 16 + 36 * c(r) + 6 * c(g) + c(b);
}

/** The styling functions for one mode and one hue. */
function paint(mode, hue) {
  const acc = accentAt(hue);
  const fg = (rgb) => (mode === "truecolor" ? `${ESC}38;2;${rgb.join(";")}m` : `${ESC}38;5;${to256(rgb)}m`);
  const bg = (rgb) => (mode === "truecolor" ? `${ESC}48;2;${rgb.join(";")}m` : `${ESC}48;5;${to256(rgb)}m`);
  const R = `${ESC}0m`;
  if (mode === "plain") {
    const id = (s) => String(s);
    return { mode, flip: id, mark: id, acc: id, dim: id, bold: id, rule: id, R: "" };
  }
  return {
    mode,
    /** Unl acting: near-black on the accent. */
    flip: (s) => `${bg(acc)}${fg(ON_ACC)}${ESC}1m${s}${R}`,
    /** The mark: near-black on Unl's cyan, fixed, whatever the hue. */
    mark: (s) => `${bg(UNL_CYAN)}${fg(ON_ACC)}${ESC}1m${s}${R}`,
    acc: (s) => `${fg(acc)}${s}${R}`,
    dim: (s) => `${fg(SOFT)}${s}${R}`,
    bold: (s) => `${ESC}1m${s}${R}`,
    // Rules are structure, not text: a set dark grey, steady across terminal themes.
    rule: (s) => `${fg([74, 78, 84])}${s}${R}`,
    R,
  };
}

const ANSI = /\x1b\[[0-9;]*m/g;
/** The width a string takes on screen, escapes excluded. Pure. */
const vlen = (s) => [...String(s).replace(ANSI, "")].length;

/** Cut or pad a styled string to exactly w visible columns, keeping its escapes. Pure. */
function fit(s, w) {
  const str = String(s);
  let out = "";
  let n = 0;
  let styled = false;
  for (let i = 0; i < str.length; ) {
    if (str[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(str.slice(i));
      if (m) { out += m[0]; i += m[0].length; styled = true; continue; }
    }
    const ch = String.fromCodePoint(str.codePointAt(i));
    if (n + 1 > w) return styled ? out + `${ESC}0m` : out;
    out += ch; n += 1; i += ch.length;
  }
  return out + " ".repeat(Math.max(0, w - n));
}

/** Word-wrap plain text to width w (a word longer than w is broken). Pure. */
function wrap(text, w) {
  const words = String(text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let cur = "";
  for (let word of words) {
    while ([...word].length > w) {
      if (cur) { lines.push(cur); cur = ""; }
      lines.push([...word].slice(0, w).join(""));
      word = [...word].slice(w).join("");
    }
    if (!cur) cur = word;
    else if ([...cur].length + 1 + [...word].length <= w) cur += " " + word;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

/** Hanging indent: the first line after `lead`, the rest under `hang` spaces. Styled per line by fn. */
function hang(lead, text, w, fn = (x) => x, hangN = [...lead.replace(ANSI, "")].length) {
  const avail = Math.max(8, w - hangN);
  return wrap(text, avail).map((l, i) => (i === 0 ? lead : " ".repeat(hangN)) + fn(l));
}

function hhmm(iso, utc = false) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : utc ? d.toISOString().slice(11, 16) : d.toTimeString().slice(0, 5);
}

/** The layout for a width. Pure. */
function layoutFor(cols) {
  if (cols >= SPLIT_MIN) {
    const shelfW = Math.max(SHELF_MIN, Math.min(SHELF_MAX, Math.round(cols * 0.3)));
    // A body row is " " + stream + " │ " + shelf: four cells beside the panes.
    return { mode: "split", streamW: cols - shelfW - 4, shelfW };
  }
  return { mode: "inline", streamW: cols, shelfW: 0 };
}

/**
 * Fold what a person does not need line by line: the same turn back to back is one group, and
 * background turns (task notifications, monitor events) from one source fold into one quiet line. Pure.
 */
function groupRepeats(serves) {
  const out = [];
  for (const s of serves) {
    const g = out[out.length - 1];
    const bg = !!viewOf(s).background;
    if (g && bg && g.bg && viewOf(g.last).source === viewOf(s).source) { g.last = s; g.n += 1; continue; }
    if (g && !bg && !g.bg && s.sig && g.last.sig === s.sig) { g.last = s; g.n += 1; continue; }
    out.push({ first: s, last: s, n: 1, bg });
  }
  return out;
}

const who = (s) => s.label || s.surface || s.channel || "an AI";
const kept = (s) => (Array.isArray(s.decisions) ? s.decisions : []);
const heldOf = (s) => (Array.isArray(s.held) ? s.held : Array.isArray(s.held_back) ? s.held_back.map((id) => ({ id })) : []);
/**
 * The readable view the server sends. Against an older server without it, the same rules run
 * here: a turn no person typed folds, and a turn is never printed as raw XML.
 */
const BACKGROUND_RX = /^\s*(?:<\s*(?:task-notification|system-reminder|local-command|command-name|command-message|bash-|tool_result|user-prompt-submit-hook)|\[SYSTEM NOTIFICATION|Stop hook feedback:)/i;
const viewOf = (s) => {
  if (s.view) return s.view;
  const t = typeof s.turn === "string" ? s.turn : "";
  const background = BACKGROUND_RX.test(t);
  const said = background || !t ? null : t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null;
  const tail = String(s.agent || "").split(/[-_:]/).filter(Boolean).pop();
  return { background, said, source: s.agent ? (/^seat/i.test(s.agent) ? `seat ${tail}` : s.agent) : who(s) };
};

/** The counts, secondary: what Unl weighed, kept and held. Pure. */
function summaryText(s) {
  const k = kept(s).length;
  const h = heldOf(s).length;
  const ptr = Number(s.as_pointer) || 0;
  const earlier = ptr ? ` · ${ptr} given earlier` : "";
  if (!k && !h) return "";
  if (s.judged) return `weighed ${k + h} · kept ${k} · held ${h}${earlier}`;
  return `handed over ${k}${earlier}`;
}

/** The one plain line a turn leads with: what Unl did for the person. The server writes it. Pure. */
function leadText(s) {
  const v = viewOf(s);
  if (v.lead) return v.lead;
  const k = kept(s);
  if (!k.length) return "Nothing you decided bore on this, so Unl stayed quiet";
  const under = s.greater && s.greater.title ? String(s.greater.title).split(/\s[—–-]\s|:\s/)[0] : "";
  return `Gave ${who(s)} ${k.length === 1 ? "one of your decisions" : `${k.length} of your decisions`}${under ? ` under ${under}` : ""}`;
}

/** The speaker column's width in the exchange: room for "Unl told your AI". */
const VOICE_W = 16;

/**
 * THE THREE BEATS: every turn, everywhere, reads
 * You asked / Unl told your AI / Your AI did, so a person learns it once. The same words as the portal's
 * TerminalView (BEATS there); the read-only public stream is someone else's turns, so it says "the AI".
 * The third beat is in one of three truthful states, from what the AI reported and nothing else: an act that
 * names a decision Unl handed over ("Your AI did", with its because), an act after the turn with no cause
 * claimed ("Then your AI"), or nothing reported (left open, nothing invented). Pure.
 */
const outcomeOfActs = (acts) => (acts.some((a) => a.because) ? "reported" : acts.length ? "then" : "open");

/**
 * Unl's answer, in its own voice: the server writes it; against an older server the line
 * mode's voiceOf composes it from the decisions by the same rule. Pure.
 */
function answerText(s) {
  const v = viewOf(s);
  const heads = Array.isArray(v.heads) ? v.heads : Array.isArray(s.heads_up) ? s.heads_up : [];
  return v.answer || voiceOf(kept(s), heads);
}

/** One group (a turn, the same turn N times, or a fold of background updates) as stream lines. Pure. */
function turnLines(g, w, p, opts = {}) {
  const s = g.last;
  const v = viewOf(s);
  const pub = opts.viewer === "public";
  const beats = beatsFor(s, pub ? "public" : "owner");
  const voiceWidth = Math.max(VOICE_W, ...Object.values(beats).map((label) => label.length));
  const lines = [];
  const time = g.n > 1 ? `${hhmm(g.first.at, opts.viewer === "public")} to ${hhmm(s.at, opts.viewer === "public")}` : hhmm(s.at, opts.viewer === "public");
  const right = (left, t) => { const gap = w - vlen(left) - t.length; return gap >= 1 ? left + " ".repeat(gap) + p.dim(t) : fit(left, Math.max(1, w - t.length - 1)) + " " + p.dim(t); };
  if (g.bg) {
    // Machine turns fold: one quiet line, never the raw notification.
    lines.push(right(p.dim(`${opts.picked ? "›" : " "} ▸ ${g.n} background update${g.n === 1 ? "" : "s"} from ${v.source || who(s)}`), time));
    return lines;
  }
  const handed = kept(s).length > 0;
  const meta = opts.picked ? [s.model, s.agent ? (v.source || s.agent) : null].filter(Boolean).join(" · ") : "";
  lines.push(right(`${opts.picked ? p.acc("›") : handed ? p.acc("⏺") : p.dim("⏺")} ${p.bold(who(s))}${meta ? p.dim(` · ${meta}`) : ""}`, time));
  // Which project Agent Unl read the turn as, so a miss is visible. Absent with one project.
  if (opts.picked && s.read) lines.push(...hang(`  ${p.dim("⎿")} ${p.dim("read as")} `, String(s.read), w));
  // THE TURN AS A CONVERSATION BETWEEN TWO AIS: the AI asks, Unl answers with what bore and
  // why, the AI acts, the moments stand out; the decision list follows, compact. Each voice has its speaker
  // in a column; on a narrow screen the speaker sits on its own line.
  // `mark` is a styled prefix (a heads-up's tag) that sits in the lead, so wrapping never cuts it.
  const voice = (label, text, fl, ft, max, mark = "") => {
    const out = w >= Math.max(60, voiceWidth + 36) ? hang(`  ${fl(label.padEnd(voiceWidth))} ${mark}`, String(text), w, ft) : [...(label ? [`  ${fl(label)}`] : []), ...hang(`    ${mark}`, String(text), w, ft)];
    return max && out.length > max ? [...out.slice(0, max - 1), `${fit(out[max - 1], w - 2).trimEnd()}${p.dim(" …")}`] : out;
  };
  // What the surface sent Unl, readable (no XML), secrets masked before storage. The public
  // terminal never shows what was sent: its slot carries Agent Unl's one-line summary.
  const asked = v.said || v.about;
  // ROUND THREE: a surface's own description of the turn is a quiet line about it,
  // never the AI speaking; and (d) when nothing bore, Unl's line stays, but quiet.
  if (v.context && (opts.picked || pub)) lines.push(...hang(`  ${p.dim("⎿")} ${p.dim("about")} `, String(v.context), w, p.dim).slice(0, opts.picked ? undefined : TURN_LINES));
  if (asked) lines.push(...voice(beats.asked, asked, p.dim, (x) => x, opts.picked ? 0 : TURN_LINES));
  lines.push(...voice(beats.told, answerText(s), p.acc, v.quiet ? p.dim : p.bold));
  const heads = Array.isArray(v.heads) ? v.heads : Array.isArray(s.heads_up) ? s.heads_up : [];
  // A moment (a heads-up, a stop for the person, a sealed decision) is set in the accent's type, in the
  // column: never a side line.
  for (const t of heads) lines.push(...voice("", String(t).replace(/^★\s*/, ""), p.dim, p.acc, 0, `${p.acc("heads-up")} `));
  const acts = Array.isArray(v.acts) ? v.acts : [];
  // Round two: an act that names a decision Unl handed over says which, as a moment.
  const outcome = outcomeOfActs(acts);
  acts.forEach((a, i) => lines.push(...voice(i === 0 ? (outcome === "reported" ? beats.did : beats.then) : "", a.because ? `${a.line} · acting on \u201c${a.because}\u201d` : a.line, p.dim, a.moment ? (x) => p.acc(p.bold(x)) : (x) => x)));
  // An open turn says nothing was reported rather than inventing an outcome; a quiet turn has no third beat.
  // Not on a public stream: its acts are withheld by design, so "not reported" would be untrue.
  if (outcome === "open" && !v.quiet && kept(s).length && !pub) lines.push(...voice(beats.did, "No report yet", p.dim, p.dim));
  const inline = !!opts.inlineShelf;
  // BENEATH THE EXCHANGE, compact: the decisions that bore, the strongest in the
  // full flip; the standing rules folded to one line that opens on the picked turn; the
  // counts and the held list are the detail.
  // ROUND TWO: when Unl answered in its own words, the list is one line until the turn is picked;
  // each decision it cites carries its [n] when the list opens. A decision the previous turn in this
  // conversation already handed over folds to one line, not repeated.
  if (!opts.picked) {
    if (kept(s).length || heldOf(s).length) lines.push(p.dim(`  ▸ Decisions and reasons${pub ? "" : ` · ${inline ? "[ ] to open" : "pick the turn to open"}`}`));
    const changes = Array.isArray(v.changes) ? v.changes : Array.isArray(s.changes) ? s.changes : [];
    for (const c of changes) lines.push(...hang("  ", String(c), w, p.dim));
    if (g.n > 1) lines.push(p.dim(`  ⎿ the same turn ${g.n} times since ${hhmm(g.first.at, opts.viewer === "public")}`));
    lines.push("");
    return lines;
  }
  const bearingAll = kept(s).filter((d) => !d.standing);
  const bearing = opts.picked ? bearingAll : bearingAll.filter((d) => !d.again);
  const again = bearingAll.length - bearing.length;
  const standing = kept(s).filter((d) => d.standing);
  bearing.forEach((d, i) => {
    const mark = d.cite ? `[${d.cite}]` : "✻";
    if (i === 0) lines.push(...hang("     ", ` ${mark} ${d.title || "A decision"}${d.again ? " · again" : ""} `, w, (x) => p.flip(x)));
    else lines.push(...hang(`      ${p.acc(mark)} `, `${d.title || "A decision"}${d.again ? " · again" : ""}`, w, p.acc));
    // Narrow (no shelf): the rest keep their whys inline; the strongest's is Unl's answer, and repeats when picked.
    if (inline && d.why && (i > 0 || opts.picked)) lines.push(...hang("       ", d.why, w, p.dim));
  });
  // THE PUBLIC STREAM CARRIES NO COUNTS OR STATUS LABELS (Neil's word on; the 6 Oct
  // blind read named "handed over · standing", "held back" and "weighed · kept · held" as machinery every time).
  // The decisions that bore stay; the bookkeeping about them is the owner's view.
  if (again && !pub) lines.push(p.dim(`  ⎿ + ${again} again from the last turn · ${inline ? "pick the turn with [ ] to see" : "pick the turn to see"}`));
  if (standing.length && !pub) {
    if (opts.picked) for (const d of standing) lines.push(...hang(`  ${p.dim("⎿ every turn")} `, d.title || "A decision", w, p.dim));
    else lines.push(p.dim(`  ⎿ + ${standing.length} of your decisions that ${standing.length === 1 ? "applies" : "apply"} to every turn · ${inline ? "pick the turn with [ ] to see" : "pick the turn to see"}`));
  }
  const counts = summaryText(s);
  if (counts && opts.picked && !pub) lines.push(p.dim(`  ⎿ ${counts}`));
  const held = heldOf(s);
  if (held.length && !pub) {
    if (inline && opts.picked) for (const h of held) { if (h.title) lines.push(...hang(`     ${p.dim("○")} `, `${h.title} · held: ${h.reason || "judged not to bear on this turn"}`, w, p.dim)); }
    else lines.push(p.dim(`  ⎿ Held back ${held.length}: not about this · ${inline ? "pick the turn with [ ] to see why" : "h on the shelf to see why"}`));
  }
  const changes = Array.isArray(v.changes) ? v.changes : Array.isArray(s.changes) ? s.changes : [];
  for (const c of changes.slice(0, opts.picked ? changes.length : 3)) lines.push(...hang(`  ${p.dim(pub ? "⎿" : "⎿ changed")} `, c, w, p.dim));
  if (!opts.picked && changes.length > 3) lines.push(p.dim(`  ⎿ +${changes.length - 3} more changes`));
  if (g.n > 1) lines.push(p.dim(`  ⎿ the same turn ${g.n} times since ${hhmm(g.first.at, opts.viewer === "public")}`));
  lines.push("");
  return lines;
}

/** The shelf pane for one turn: Claude Code's right-panel restraint. Held decisions stay a count until asked. Pure. */
function shelfLines(s, w, p, opts = {}) {
  const out = [];
  if (!s) return [p.dim("In play"), p.rule("─".repeat(w)), ...hang("", "The next turn's decisions appear here.", w, p.dim)];
  out.push(fit(`${p.bold("In play")}${p.dim(` · ${hhmm(s.at, opts.viewer === "public")} · ${who(s)}`)}`, w));
  out.push(p.rule("─".repeat(w)));
  // The heading says what the turn was about, never the lead line again.
  const subject = viewOf(s).subject || (s.greater && s.greater.title ? `Under ${s.greater.title}` : null);
  if (subject) out.push(...hang("", subject, w, p.bold));
  const pub = opts.viewer === "public";
  const counts = summaryText(s);
  if (counts && !pub) out.push(p.dim(counts));
  out.push("");
  // Bearing decisions first, standing rules after: the shelf reads this turn first.
  [...kept(s).filter((d) => !d.standing), ...kept(s).filter((d) => d.standing)].forEach((d, k) => {
    const n = pub ? "" : Number(d.served) > 0 ? ` ${d.served}${d.standing ? " every turn" : ""}` : d.standing ? " every turn" : "";
    // The strongest match carries the full flip; the rest are the accent as type.
    const tone = k === 0 ? (x) => p.flip(x) : (x) => p.acc(x);
    for (const [i, l] of wrap(d.title || "A decision", w - 4 - n.length).entries()) out.push(tone(fit(`${i === 0 ? " ✻ " : "   "}${l}`, w - n.length - 1) + (i === 0 ? n : " ".repeat(n.length)) + " "));
    if (d.why) out.push(...hang(" ", d.why, w, p.dim));
    out.push("");
  });
  const held = pub ? [] : heldOf(s);
  if (held.length && !opts.showHeld) out.push(p.dim(`${held.length} held back · h to see why`));
  if (held.length && opts.showHeld) {
    for (const h of held) {
      if (!h.title) continue;
      out.push(...hang("○ ", h.title, w));
      out.push(...hang("  ", `held: ${h.reason || "judged not to bear on this turn"}`, w, p.dim));
    }
    const untitled = held.filter((h) => !h.title).length;
    if (untitled) out.push(p.dim(`${untitled} held back to one line`));
  }
  out.push("");
  if (!pub) out.push(...hang("", "lit: handed to your AI · number: served in 30 days", w, p.dim));
  return out;
}

/**
 * The whole screen, exactly rows × cols. Pure: state in, rows out.
 * state: { serves (oldest first), workspace, status, agent, scroll (lines up from the tail), pick (group index or null) }
 */
function frame(state, cols, rows, mode, hue, opts = {}) {
  const p = paint(mode, hue);
  const L = state.pick == null ? { mode: "inline" } : layoutFor(cols);
  const groups = groupRepeats(state.serves || []);
  // The shelf follows the picked turn, else the latest turn a person or their AI actually sent.
  // The public terminal's private turns have nothing to shelve, so the shelf skips them too.
  const lastReal = (() => { for (let i = groups.length - 1; i >= 0; i--) if (!groups[i].bg && !viewOf(groups[i].last).private) return i; for (let i = groups.length - 1; i >= 0; i--) if (!groups[i].bg) return i; return groups.length - 1; })();
  const pickI = state.pick == null ? lastReal : Math.max(0, Math.min(groups.length - 1, state.pick));
  const current = groups[pickI] ? groups[pickI].last : null;

  const status = state.status === "live" ? p.acc("● live") : p.dim(`○ ${state.status || "connecting"}`);
  const headL = `${p.mark(" Unl ")} ${p.bold("terminal")}${state.workspace ? p.dim(`  ·  ${state.workspace}`) : ""}`;
  const headR = `${p.dim(`watching ${state.agent || "every AI"}`)}  ${status} `;
  const gap = cols - vlen(headL) - vlen(headR);
  const header = gap >= 1 ? headL + " ".repeat(gap) + headR : fit(headL, cols);
  // Read-only: no keys to offer, and it says it runs behind.
  const keys = opts.readOnly ? (cols >= 60 ? "read-only · about 10 minutes behind" : "read-only") : cols >= 100 ? "a  agent   ↑↓  scroll   [ ]  details   h  held   end  follow   q  quit" : cols >= 50 ? "a · ↑↓ · [ ] · h · q quit" : "q quit";
  // The ┬ sits over the │: a body row is " " + stream (streamW) + " " + "│", so the divider is column streamW + 2.
  const ruleTop = L.mode === "split" ? p.rule("─".repeat(L.streamW + 2) + "┬" + "─".repeat(cols - L.streamW - 3)) : p.rule("─".repeat(cols));

  const sw = L.mode === "split" ? L.streamW : cols - 1;
  let stream = [];
  groups.forEach((g, i) => {
    stream = stream.concat(turnLines(g, sw, p, { inlineShelf: L.mode === "inline", picked: i === pickI && state.pick != null, viewer: opts.viewer || (opts.readOnly ? "public" : "owner") }));
  });
  if (!groups.length) stream = state.status === "live" ? hang("", EMPTY_TEXT, sw, p.dim) : [p.dim("Connecting to Unl…")];
  // The starter's one quiet offer: this folder is a project Unl is not wired into yet.
  if (state.tip) stream = [...hang("", state.tip, sw, p.acc), "", ...stream];
  // The cursor blinks with the drift tick: Unl is live and listening.
  const cursor = state.blink === false ? " " : p.flip(" ");
  const prompt = `${p.acc(">")} ${cursor}`;

  const bodyH = Math.max(1, rows - 4);
  const maxUp = Math.max(0, stream.length - bodyH);
  const up = Math.max(0, Math.min(state.scroll || 0, maxUp));
  const view = stream.slice(Math.max(0, stream.length - bodyH - up), stream.length - up);
  while (view.length < bodyH) view.push("");

  const out = [fit(header, cols), fit(ruleTop, cols)];
  if (L.mode === "split") {
    const shelf = shelfLines(current, L.shelfW, p, { showHeld: !!state.showHeld, viewer: opts.viewer || (opts.readOnly ? "public" : "owner") });
    for (let r = 0; r < bodyH; r++) out.push(fit(` ${fit(view[r], L.streamW)} ${p.rule("│")} ${fit(shelf[r] ?? "", L.shelfW)}`, cols));
  } else {
    for (let r = 0; r < bodyH; r++) out.push(fit(view[r], cols));
  }
  const tail = up ? p.dim(`↓ ${up} lines below · end to follow`) : opts.readOnly ? "" : prompt;
  const gapF = cols - vlen(tail) - keys.length - 1;
  out.push(p.rule("─".repeat(cols)));
  out.push(fit(gapF >= 1 ? tail + " ".repeat(gapF) + p.dim(keys) + " " : tail, cols));
  // A font without the glyphs (wantsAscii): each becomes one ASCII character, so every width holds.
  return opts.ascii ? out.map(asciiOf) : out;
}

/** Run it: the alternate screen, the poll, the keys, the drift and live resize. */
async function runTui({ api, key, agent: agentIn = "", tip = "", self = "unl", fetchImpl = fetch, out = process.stdout, input = process.stdin, env = process.env }) {
  const mode = colorMode(env, !!out.isTTY);
  const ascii = wantsAscii(env);
  const still = !!env.UNL_REDUCED_MOTION;
  const state = { serves: [], workspace: "", status: "connecting", agent: agentIn, scroll: 0, pick: null, receivers: [], tip };
  const seen = new Map();
  let hue = HUE_START;
  let stop = false;
  let fatal = null;
  let wake = null;

  const draw = () => {
    const cols = out.columns || 100;
    const rows = out.rows || 30;
    out.write(`${ESC}H` + frame(state, cols, rows, mode, hue, { ascii }).join("\r\n"));
  };
  const restore = () => { out.write(`${ESC}0m${ESC}?25h${ESC}?1049l`); if (input.isTTY) input.setRawMode(false); input.pause(); };

  out.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
  const onResize = () => { out.write(`${ESC}2J`); draw(); };
  out.on("resize", onResize);
  if (input.isTTY) input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  const onKey = (k) => {
    if (k === "q" || k === "\u0003") { stop = true; if (wake) wake(); return; }
    if (k === "\x1b[A" || k === "k") state.scroll += 1;
    else if (k === "\x1b[B" || k === "j") state.scroll = Math.max(0, state.scroll - 1);
    else if (k === "\x1b[5~") state.scroll += Math.max(1, (out.rows || 30) - 4);
    else if (k === "\x1b[6~") state.scroll = Math.max(0, state.scroll - Math.max(1, (out.rows || 30) - 4));
    else if (k === "\x1b[F" || k === "\x1b[4~" || k === "G") { state.scroll = 0; state.pick = null; }
    else if (k === "h") {
      if (state.pick == null) state.pick = Math.max(0, groupRepeats(state.serves).length - 1);
      state.showHeld = !state.showHeld;
    }
    else if (k === "[" || k === "]") {
      const n = groupRepeats(state.serves).length;
      if (state.pick == null) state.pick = Math.max(0, n - 1);
      else if (state.pick === n - 1 && k === "]") state.pick = null;
      else state.pick = Math.max(0, Math.min(n - 1, state.pick + (k === "[" ? -1 : 1)));
    } else if (k === "a") {
      const names = ["", ...state.receivers.map((r) => r.who).filter(Boolean)];
      state.agent = names[(names.indexOf(state.agent) + 1) % names.length] || "";
      state.serves = []; seen.clear(); state.pick = null; state.scroll = 0;
      if (wake) wake();
    }
    draw();
  };
  input.on("data", onKey);
  const t0 = Date.now();
  const drift = mode === "plain" ? null : setInterval(() => {
    if (!still) hue = hueAt((Date.now() - t0) / 1000);
    state.blink = !state.blink;
    draw();
  }, DRIFT_MS);

  try {
    while (!stop) {
      try {
        const q = `?limit=50${state.agent ? `&agent=${encodeURIComponent(state.agent)}` : ""}`;
        const res = await fetchImpl(`${api}/api/serve-log${q}`, { headers: { authorization: `Bearer ${key}`, "user-agent": "unl-terminal/0.2" } });
        if (res.status === 401) { fatal = new Error(`This machine's key was not accepted (revoked?). Run \`${self}\` to sign in again.`); break; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        state.workspace = body.workspace || state.workspace;
        state.receivers = Array.isArray(body.receivers) ? body.receivers : state.receivers;
        for (const s of [...(body.serves || [])].reverse()) {
          const k = keyOf(s);
          // A turn already shown takes the newer copy: Unl's reply and the AI's acts land after it.
          if (seen.has(k)) { const i = state.serves.findIndex((x) => keyOf(x) === k); if (i >= 0) state.serves[i] = s; continue; }
          seen.set(k, true);
          state.serves.push(s);
        }
        if (state.serves.length > KEEP) state.serves = state.serves.slice(-KEEP);
        state.status = "live";
      } catch {
        state.status = "reconnecting";
      }
      draw();
      await new Promise((r) => { wake = r; setTimeout(r, POLL_MS); });
      wake = null;
    }
  } finally {
    if (drift) clearInterval(drift);
    input.off("data", onKey);
    out.off("resize", onResize);
    restore();
  }
  if (fatal) throw fatal;
}

module.exports = { UNL_CYAN, EMPTY_TEXT, runTui, frame, wantsAscii, glyphsFor: (env, platform) => (wantsAscii(env, platform) ? "ascii" : "unicode"), layoutFor, colorMode, paint, accentAt, to256, fit, wrap, vlen, groupRepeats, turnLines, shelfLines, summaryText, hueAt, SPLIT_MIN, HUE_START, HUE_CENTRE, HUE_SWING };
