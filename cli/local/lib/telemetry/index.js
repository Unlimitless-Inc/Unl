"use strict";
/*
 * The opt-in ping.
 *
 * WHY IT EXISTS. Download counts say how many people fetched Unl and nothing about whether it was
 * any use to them. The one number that says whether Unl deserves to exist is whether people are
 * still keeping decisions a few weeks after they installed it. Without a ping that number cannot be
 * read at all, so the ping exists, and it is built so that turning it on costs a person nothing
 * they would mind.
 *
 * THE RULES IT IS BUILT TO.
 *   Off until the person turns it on. No id exists before then, so there is nothing to send.
 *   Four events and nothing else: installed, a decision kept, Unl spoke first, used on a later day.
 *   No content, no file names, no project names, no account. A random id the person can reset.
 *   What it sends is shown in plain words before it is turned on, and again whenever asked.
 *   Every ping is kept in a local log, so the person can read exactly what left.
 *   DO_NOT_TRACK is honoured, and nothing is ever sent from CI.
 *   A yes covers what was shown. If what is sent ever changes, the ping stops until the person
 *   has seen the new list and turned it on again.
 *   It goes to Unl's own server and to no analytics company.
 *   It never slows a command and never fails one: a ping that cannot be sent is dropped.
 *
 * WHAT IS NOT HERE. Anything about the hosted Unl. A person who signs in to the hosted service has
 * their own figures there, and the two are never joined.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

/** The payload's shape. A change to what is sent is a new version, never a quiet edit. */
const VERSION = 1;
/** The four things that can be sent. Anything else is refused before it is written anywhere. */
const EVENTS = ["install", "decision_kept", "spoke_first", "later_day"];
const DEFAULT_URL = "https://api.unlimitless.ai/public/open/ping";
/** How long a ping may take before it is given up. A ping is never worth making someone wait. */
const SEND_TIMEOUT_MS = 2000;
/** The most pings kept waiting. Older ones are dropped, so a machine offline for a month sends a handful, not a flood. */
const MAX_QUEUE = 50;
/** The most lines of the local log kept. */
const MAX_LOG_LINES = 500;
/** The largest count one ping carries. */
const MAX_COUNT = 1000;

function homeDir(env = process.env) {
  return env.UNL_HOME || path.join(os.homedir(), ".unl");
}
const stateFile = (home) => path.join(home, "telemetry.json");
const queueFile = (home) => path.join(home, "telemetry-queue.jsonl");
const logFile = (home) => path.join(home, "telemetry.log");

/** The day in UTC, as YYYY-MM-DD. Only ever compared on this machine; it is not sent. */
const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

function readState(home) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(home), "utf8"));
    return { on: s.on === true, id: typeof s.id === "string" ? s.id : null, agreed: Number.isInteger(s.agreed) ? s.agreed : null, installSent: s.installSent === true, lastDay: typeof s.lastDay === "string" ? s.lastDay : null };
  } catch {
    return { on: false, id: null, agreed: null, installSent: false, lastDay: null };
  }
}

function writeState(home, state) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(stateFile(home), JSON.stringify(state, null, 2) + "\n");
}

/**
 * Why nothing would be sent right now, or null when a ping may go. The person's own switch comes
 * first; the environment can only ever turn sending off, never on.
 */
function blockedBy(state, env = process.env) {
  if (!state.on) return "off";
  // The person said yes to one list of things. A different list needs a new yes.
  if (state.agreed !== VERSION) return "what it sends has changed since you turned it on";
  const dnt = String(env.DO_NOT_TRACK || "").trim().toLowerCase();
  if (dnt && dnt !== "0" && dnt !== "false") return "DO_NOT_TRACK is set";
  const own = String(env.UNL_TELEMETRY || "").trim().toLowerCase();
  if (["0", "off", "false", "no"].includes(own)) return "UNL_TELEMETRY is off";
  const ci = String(env.CI || "").trim().toLowerCase();
  if ((ci && ci !== "0" && ci !== "false") || env.GITHUB_ACTIONS || env.GITLAB_CI || env.BUILDKITE || env.JENKINS_URL || env.TF_BUILD) return "this is a CI run";
  return null;
}

/** Exactly what one ping carries. Built in one place so the disclosure and the wire can never differ. */
function payload(event, state, { count, unlVersion } = {}) {
  if (!EVENTS.includes(event)) throw new Error(`"${event}" is not something Unl sends`);
  const body = { v: VERSION, event, id: state.id, unl: String(unlVersion || "unknown").slice(0, 20) };
  if (event === "decision_kept" || event === "spoke_first") body.n = Math.max(1, Math.min(MAX_COUNT, Math.floor(Number(count) || 1)));
  return body;
}

/** The disclosure: what is sent, in plain words. Shown before it is turned on and whenever asked. */
function disclosure(self = "npx unlimitless") {
  return [
    "Unl can send an anonymous ping so the people who make it can tell whether it is any use.",
    "It is off until you turn it on.",
    "",
    "It sends four things and nothing else.",
    "  that Unl was installed (once, when you turn this on)",
    "  that you kept a decision, and how many (a number, never the words)",
    "  that Unl spoke first before your agent acted, and how many times",
    "  that Unl was used on a later day (at most once a day)",
    "",
    "With each one go the version of Unl and a random id made on this machine.",
    "The id is not tied to you, your machine or your project, and you can replace it at any time.",
    "It is there for one reason: so that a decision kept a month after installing can be counted.",
    "",
    "A ping is one line. This is all of it.",
    `  ${JSON.stringify(payload("decision_kept", { id: "a-random-id-made-when-you-turn-it-on" }, { count: 3, unlVersion: "1.0.0" }))}`,
    "",
    "It never sends your decisions, their reasons, your code, file names, folder names,",
    "project names, prompts, your name or your email.",
    "It goes to Unl's own server and to no analytics company.",
    "Your address reaches that server as it does with any request. Unl does not store it.",
    "Every ping is kept in a log on this machine, so you can read exactly what was sent.",
    "",
    `  ${self} telemetry on      turn it on`,
    `  ${self} telemetry off     turn it off`,
    `  ${self} telemetry show    every ping from this machine, exactly as it went`,
    `  ${self} telemetry reset   replace the random id`,
    "",
    "Setting DO_NOT_TRACK=1 stops it, and it never sends from CI.",
  ].join("\n");
}

/** The one line a first run may print. It asks for nothing and says where the detail is. */
function offerLine(self = "npx unlimitless") {
  return `Telemetry is off. \`${self} telemetry\` shows the four things it would send, and \`${self} telemetry on\` turns it on.`;
}

function appendCapped(file, line, max) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {}
  lines.push(line);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.slice(-max).join("\n") + "\n");
}

/**
 * Note that something happened. Writes one line to the queue and returns; it never touches the
 * network, so a hook can call it without slowing an agent. Returns false when nothing was written
 * because the ping is off or blocked.
 *
 * @param {"install" | "decision_kept" | "spoke_first" | "later_day"} event
 * @param {{ count?: number, unlVersion?: string, home?: string, env?: object, now?: number }} [opts]
 */
function record(event, opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || homeDir(env);
  const state = readState(home);
  if (blockedBy(state, env) || !state.id) return false;
  const now = opts.now || Date.now();
  const today = dayOf(now);
  // The first thing ever sent is that Unl was installed, whatever happened first.
  if (!state.installSent) {
    appendCapped(queueFile(home), JSON.stringify(payload("install", state, opts)), MAX_QUEUE);
    state.installSent = true;
    state.lastDay = today;
    writeState(home, state);
    if (event === "install" || event === "later_day") return true;
  } else if (event === "install") {
    return false;
  }
  if (event === "later_day") {
    if (state.lastDay && state.lastDay >= today) return false;
    state.lastDay = today;
    writeState(home, state);
  }
  appendCapped(queueFile(home), JSON.stringify(payload(event, state, opts)), MAX_QUEUE);
  return true;
}

/** Note that Unl was used today. Sends "used on a later day" at most once a day, and never on the day of install. */
function noteSession(opts = {}) {
  return record("later_day", opts);
}

/**
 * Send what is waiting. Each ping is written to the local log before it goes. A ping that cannot
 * be sent is dropped, not retried for ever: a missed ping is a smaller cost than a tool that keeps
 * knocking on a network that said no.
 *
 * @returns {Promise<{ sent: number, dropped: number, blocked: string | null }>}
 */
async function flush(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || homeDir(env);
  const state = readState(home);
  const blocked = blockedBy(state, env);
  let lines = [];
  try {
    lines = fs.readFileSync(queueFile(home), "utf8").split("\n").filter(Boolean);
  } catch {}
  if (!lines.length) return { sent: 0, dropped: 0, blocked };
  // The queue is emptied first, so two commands running together never send the same ping twice.
  try {
    fs.writeFileSync(queueFile(home), "");
  } catch {}
  if (blocked) return { sent: 0, dropped: lines.length, blocked };
  const url = env.UNL_TELEMETRY_URL || DEFAULT_URL;
  const fetchImpl = opts.fetch || fetch;
  const deadline = Date.now() + (opts.timeoutMs || SEND_TIMEOUT_MS);
  let sent = 0;
  let dropped = 0;
  for (const body of lines) {
    const left = deadline - Date.now();
    let result = "not sent";
    if (left > 0) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), left);
      try {
        const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: ctrl.signal });
        result = res && res.ok ? "sent" : `refused (${res ? res.status : "no answer"})`;
      } catch {
        result = "not sent";
      } finally {
        clearTimeout(timer);
      }
    }
    if (result === "sent") sent++;
    else dropped++;
    try {
      appendCapped(logFile(home), `${new Date(opts.now || Date.now()).toISOString()}\t${result}\t${body}`, MAX_LOG_LINES);
    } catch {}
  }
  return { sent, dropped, blocked: null };
}

/** Note something and send it now. For a command a person ran themselves, where a short wait at the end is fine. */
async function track(event, opts = {}) {
  if (!record(event, opts)) return { sent: 0, dropped: 0, blocked: blockedBy(readState(opts.home || homeDir(opts.env || process.env)), opts.env || process.env) };
  return flush(opts);
}

/** Send what is waiting from a separate process that outlives this one, so a hook returns at once. */
function flushDetached(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || homeDir(env);
  if (blockedBy(readState(home), env)) return false;
  try {
    const { spawn } = require("child_process");
    const child = spawn(process.execPath, [__filename, "--flush"], { detached: true, stdio: "ignore", env: { ...env, UNL_HOME: home } });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function turnOn(home, opts = {}) {
  const state = readState(home);
  state.on = true;
  state.agreed = VERSION;
  if (!state.id) state.id = (opts.randomId || crypto.randomUUID)();
  writeState(home, state);
  return state;
}

function turnOff(home) {
  const state = readState(home);
  state.on = false;
  writeState(home, state);
  try {
    fs.writeFileSync(queueFile(home), "");
  } catch {}
  return state;
}

/** A new random id. Whatever was sent under the old one can no longer be joined to what is sent next. */
function resetId(home, opts = {}) {
  const state = readState(home);
  state.id = state.on ? (opts.randomId || crypto.randomUUID)() : null;
  state.installSent = false;
  state.lastDay = null;
  writeState(home, state);
  try {
    fs.writeFileSync(queueFile(home), "");
  } catch {}
  return state;
}

function readLog(home, n = 20) {
  try {
    return fs.readFileSync(logFile(home), "utf8").split("\n").filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

/**
 * The command.
 *
 * @param {string[]} argv  the arguments after `telemetry`
 * @param {{ out?: (s: string) => void, home?: string, env?: object, self?: string, unlVersion?: string, fetch?: Function }} [io]
 */
async function run(argv = [], io = {}) {
  const out = io.out || ((s) => process.stdout.write(s + "\n"));
  const env = io.env || process.env;
  const home = io.home || homeDir(env);
  const self = io.self || "npx unlimitless";
  const cmd = argv[0] || "status";
  const state = readState(home);

  if (cmd === "status" || cmd === "--help" || cmd === "-h" || cmd === "help") {
    out(disclosure(self));
    out("");
    const blocked = blockedBy(state, env);
    if (!state.on) out("Telemetry is off on this machine.");
    else if (state.agreed !== VERSION) out(`Telemetry was on, and what it sends has changed since then, so it has stopped. The list above is the new one. \`${self} telemetry on\` turns it on again.`);
    else if (blocked) out(`Telemetry is on, and nothing is being sent because ${blocked}.`);
    else out(`Telemetry is on. This machine's random id is ${state.id}.`);
    if (state.on && state.id) out(`A ping from this machine looks like this.\n  ${JSON.stringify(payload("decision_kept", state, { count: 1, unlVersion: io.unlVersion }))}`);
    return 0;
  }
  if (cmd === "on") {
    if (state.on && state.agreed === VERSION) { out(`Telemetry is already on. \`${self} telemetry\` shows what it sends.`); return 0; }
    out(disclosure(self));
    out("");
    const next = turnOn(home, io);
    const res = await track("install", { ...io, home, env });
    const blocked = blockedBy(next, env);
    out(blocked ? `Telemetry is on, and nothing will be sent while ${blocked}.` : `Telemetry is on. This machine's random id is ${next.id}.${res.sent ? "" : " The first ping could not be sent and was dropped."}`);
    return 0;
  }
  if (cmd === "off") {
    turnOff(home);
    out(`Telemetry is off. Nothing more will be sent. \`${self} telemetry reset\` also replaces the random id.`);
    return 0;
  }
  if (cmd === "reset") {
    const next = resetId(home, io);
    out(next.on ? `This machine has a new random id, ${next.id}. Nothing sent before can be joined to what is sent from now on.` : "The random id is gone. Telemetry is off, so a new one is made only if you turn it on.");
    return 0;
  }
  if (cmd === "show") {
    const lines = readLog(home, 50);
    if (!lines.length) { out("This machine has not sent a ping."); return 0; }
    out("Every ping from this machine, oldest first, with the time, what happened to it and exactly what it carried.");
    for (const l of lines) out(`  ${l.replace(/\t/g, "  ")}`);
    return 0;
  }
  out(`${self} telemetry: there is no "${cmd}". Try ${self} telemetry, on, off, show or reset.`);
  return 2;
}

module.exports = { VERSION, EVENTS, DEFAULT_URL, MAX_COUNT, homeDir, readState, blockedBy, payload, disclosure, offerLine, record, noteSession, flush, track, flushDetached, turnOn, turnOff, resetId, readLog, run };

if (require.main === module) {
  if (process.argv[2] === "--flush") flush().then(() => process.exit(0), () => process.exit(0));
  else run(process.argv.slice(2)).then((code) => process.exit(code), () => process.exit(1));
}
