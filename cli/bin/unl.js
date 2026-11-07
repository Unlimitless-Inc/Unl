#!/usr/bin/env node
"use strict";
/*
 * unl — the Unl CLI. `npm install -g unlimitless`, then `unl`; `npx unlimitless …` runs the same commands without
 * installing.
 *
 * ONE PACKAGE, TWO DOORS.
 * `unl init` and the record's own commands (status, list, why, keep, replace, retire, review, sync,
 * remove, receipt, adr, telemetry, serve, judge, export, up) are the free Unl, on this machine, with no
 * login, no account and no key at install or in use. They live in ../local and run there.
 * The hosted Unl is the step up: `unl login` signs this machine in, `unl connect` wires a project to it,
 * and `unl terminal` (or bare `unl`, once signed in) shows its side of each turn.
 *
 * `unl` on its own is the starter, as `claude` is Claude Code's: with a key on the machine it opens the
 * full-screen Unl terminal. With none it prints the help. It never starts a sign-in by itself, and it
 * never wires the current folder.
 *
 * THE PRINCIPLE: the developer INSTALLS Unl; they never have to OPERATE it. So connect asks
 * exactly two things of them: sign in once in the browser, and say yes (or no) to Unl reading the
 * files where they already wrote their decisions. Everything else is wiring, done here, printed.
 *
 *   connect            Claude Code (default): sign-in, MCP server, the enforcing hook, unl.md, import
 *   connect --cursor   Cursor: the same, wired through Cursor's MCP config and session-start hook
 *   connect --codex    Codex: the server (read tools pre-approved, OAuth sign-in) and the per-turn hook, in ~/.codex/config.toml
 *   --dry-run       print what connect would change, and change nothing (no sign-in either)
 *   --repair        update connect's own entries in place (its local "unl" server); never adds a second
 *   (no command)    the Unl terminal on a signed-in machine; the help on one that is not
 *   login / logout  sign this machine in, or remove its key
 *   status          what Unl holds in this folder, and what of the hosted Unl is on this machine
 *   --version, --help
 *   terminal        the Unl terminal: Unl's side of each turn, live, full screen (--agent <id> for one agent, --lines for one line per step)
 *   --yes           answer yes to the import (for scripted installs)
 *   --no-import     skip reading files
 *   --from <tag>    where you came from (the /connect page fills this in, e.g. --from chatgpt)
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const { signIn, mintKey } = require("../lib/oauth");
const { discoverFiles, importFiles } = require("../lib/firstHour");
const { wireClaudeHook, wireClaudeMcp, wireCursor, wireCodex, detectCodex, writeUnlMd, isUnlHook, commandPath, detectClaude, detectCursor, planWiring, describeFound, notAProject, closingLine } = require("../lib/wire");
const { surfaceTableText } = require("../lib/surfaces");
const { runTerminal } = require("../lib/terminal");
const { runTui, paint: tuiPaint, colorMode } = require("../lib/tui");
const { version, selfCommand, helpText, unknownText, headerText, unwiredProject, initOffer, keyState } = require("../lib/start");

const API = (process.env.UNL_API_URL || "https://api.unlimitless.ai").replace(/\/+$/, "");
const MCP_URL = `${API}/mcp`;
const HOME = process.env.UNL_HOME || path.join(os.homedir(), ".unl");
const KEY_FILE = path.join(HOME, "reach-key");
const PKG = path.join(__dirname, "..");
/** What to tell a person to type: `unl` when installed, `npx unlimitless` when run through npx. */
const SELF = selfCommand();
/** The free Unl, on this machine. Loaded only when one of its commands runs, so the hosted commands never open a database. */
const freeUnl = () => require("../local/bin/unl.js");
const LOCAL_COMMANDS = ["status", "list", "why", "keep", "replace", "retire", "review", "sync", "remove", "receipt", "adr", "telemetry", "serve", "judge", "export", "up", "mcp", "address"];

const say = (s = "") => process.stdout.write(s + "\n");
const step = (s) => say(`\n• ${s}`);

function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve("");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a.trim()))));
}

function readKey() {
  try {
    const k = fs.readFileSync(KEY_FILE, "utf8").trim();
    return k.startsWith("unl_rk_") ? k : "";
  } catch {
    return "";
  }
}

/** Is the key on this machine still accepted? A wake read is cheap, read-only and keyed. */
async function keyWorks(key) {
  return (await keyState(API, key)) === "ok";
}

/** The browser sign-in, then this machine's named key, written where every command reads it. */
async function signInAndStore(surface, from, indent = "  ") {
  const accessToken = await signIn({ apiBase: API, say: (s) => say(indent + s.replace(/\n/g, "\n" + indent)) });
  const minted = await mintKey({ apiBase: API, accessToken, surface, from });
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY_FILE, minted.key + "\n", { mode: 0o600 });
  fs.chmodSync(KEY_FILE, 0o600);
  say(`${indent}Signed in. This machine's key is named "${minted.name}" (ends ${minted.last4}); you can revoke it at unlimitless.ai/portal/keys.`);
  return minted.key;
}

function installRuntime() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  for (const f of ["hook.cjs", "headers.cjs"]) fs.copyFileSync(path.join(PKG, "runtime", f), path.join(HOME, f));
  return { hookPath: path.join(HOME, "hook.cjs"), headersPath: path.join(HOME, "headers.cjs") };
}

async function ensureKey(surface, from) {
  const existing = readKey();
  if (existing && (await keyWorks(existing))) {
    say("  Already signed in on this machine.");
    return existing;
  }
  return signInAndStore(surface, from);
}

async function firstHour(repo, key, flags) {
  if (flags.has("--no-import")) return;
  const files = discoverFiles(repo);
  if (!files.length) {
    say("  No CLAUDE.md, AGENTS.md, rules file, README or ADR folder here, so there is nothing to read yet.");
    say("  Unl will pick up decisions as you make them: when you tell your agent \"we don't do that here, because...\", it offers to keep it.");
    return;
  }
  say("  These files usually hold decisions you have already made:");
  for (const f of files) say(`    ${f}`);
  let answer = flags.has("--yes") ? "yes" : await ask("  Should Unl read them and pull out the decisions for you to check? Nothing is kept until you confirm it with your agent. [Y/n] ");
  if (!process.stdin.isTTY && !flags.has("--yes")) {
    say(`  Skipped: this is not an interactive terminal. Run \`${SELF} connect --yes\` to read them.`);
    return;
  }
  if (/^n/i.test(answer)) {
    say(`  Left alone. Run \`${SELF} connect\` again whenever you want Unl to read them.`);
    return;
  }
  const results = await importFiles({ apiBase: API, key, repo, files, home: HOME });
  let total = 0;
  for (const r of results) {
    if (r.error) say(`    ${r.file}: not read (${r.error})`);
    else if (r.skipped) say(`    ${r.file}: already read, unchanged`);
    else {
      total += r.found;
      say(`    ${r.file}: ${r.found} possible decision${r.found === 1 ? "" : "s"}`);
    }
  }
  if (total) say(`  ${total} possible decision${total === 1 ? "" : "s"} waiting. Your agent will put them to you one at a time; keep the right ones in your own words.`);
}

/** `--from <tag>`: a short lowercase word or nothing. The server keeps it only if it is on its list. */
function fromOf(argv) {
  const i = argv.indexOf("--from");
  const v = i >= 0 ? String(argv[i + 1] || "").trim().toLowerCase() : "";
  return /^[a-z0-9.-]{1,32}$/.test(v) ? v : undefined;
}

/** What `claude mcp list` prints, for connectors and servers no file shows. Empty when claude is absent. */
function claudeListText() {
  const r = require("child_process").spawnSync("claude", ["mcp", "list"], { cwd: process.cwd(), encoding: "utf8", timeout: 45000 });
  return r.status === 0 ? String(r.stdout || "") : "";
}

/** `unl connect`: wire this project to the hosted Unl (what `init` did before the free Unl came into the package). */
async function connect(flags) {
  const repo = process.cwd();
  const cursor = flags.has("--cursor");
  const codex = !cursor && flags.has("--codex");
  const surface = cursor ? "cursor" : codex ? "codex" : "claude-code";
  const agentName = cursor ? "Cursor" : codex ? "Codex" : "Claude Code";
  const dry = flags.has("--dry-run");
  const repair = flags.has("--repair");

  // NOT IN A PROJECT: run from the home folder there is nothing to read and unl.md would land in
  // it. Claude Code and Cursor wire per folder, so init stops and says where to run it. Codex wires the user
  // config, so that still happens; only unl.md and the read step, which belong to a project, are skipped.
  const homeRun = notAProject(repo, os.homedir());
  if (homeRun && !codex) {
    say(`This is your home folder, not a project. Run \`${SELF} connect${cursor ? " --cursor" : ""}\` inside the project you want ${agentName} to reach Unl from.`);
    return;
  }

  // NEVER DOUBLE-WIRE: look before writing. What is already here is said plainly and
  // left alone; only what is missing is added. A folder already fully wired stops here, before sign-in.
  const found = cursor ? detectCursor(repo, { home: os.homedir() }) : codex ? detectCodex(repo, { home: os.homedir() }) : detectClaude(repo, { home: os.homedir(), listText: claudeListText() });
  const plan = planWiring(found, { repair });
  if (homeRun) plan.writeUnlMd = false;
  const lines = describeFound(found, repo);
  if (lines.length) {
    say(`Unl is already wired here:`);
    for (const l of lines) say(`  ${l}`);
  }
  const serverAct = plan.addServer ? "add" : plan.replaceServer ? "replace" : null;
  if (dry) {
    say("\nDry run, nothing written. connect would:");
    say(`  ${serverAct === "add" ? "add the unl server" : serverAct === "replace" ? "update the unl server in place" : "leave the server as it is"}`);
    say(`  ${plan.addHook ? "add the hook that serves your decisions on every turn" : "leave the hook as it is"}`);
    say(`  ${plan.writeUnlMd ? "write unl.md" : "leave unl.md as it is"}`);
    return;
  }
  if (!serverAct && !plan.addHook && !plan.writeUnlMd) {
    say(`\nNothing was added: this folder already reaches Unl, and a second hook or server would serve every turn twice.`);
    if (!repair && found.servers.some((s) => s.scope === "local" && s.name === "unl")) say(`To update Unl's own entry in place, run \`${SELF} connect --repair\`.`);
    return;
  }

  say(`Installing Unl for ${agentName} in ${repo}`);

  step("Sign in");
  const key = await ensureKey(surface, fromOf(process.argv));

  step("Wire your agent");
  const { hookPath, headersPath } = installRuntime();
  let hookAdded = false;
  if (cursor) {
    const c = wireCursor(repo, { url: MCP_URL, hookPath, skipMcp: !plan.addServer, skipHook: !plan.addHook });
    say(`  .cursor/mcp.json: ${c.mcpAdded ? "added the unl server" : "unl server already there"}`);
    hookAdded = !!c.hookAdded;
    say(`  .cursor/hooks.json: ${c.hookAdded ? "added the session-start hook" : "session-start hook already there"}`);
    say("  The first time Cursor uses the unl server it asks you to sign in once. That is Cursor's own sign-in.");
  } else if (codex) {
    const c = wireCodex(os.homedir(), { url: MCP_URL, hookPath, skipMcp: !plan.addServer, skipHook: !plan.addHook });
    hookAdded = !!c.hookAdded;
    const where = (f) => f.replace(os.homedir(), "~");
    say(`  ${where(c.file)}: ${c.mcpAdded ? "added the unl server (its read tools run without asking; anything else asks first)" : "Unl's server already there"}`);
    say(`  ${c.hookFile ? where(c.hookFile) : "Hook"}: ${c.hookAdded ? "added the hook that serves your decisions on every turn" : "a hook already serves Unl, so none was added"}`);
    if (c.mcpAdded) {
      const login = require("child_process").spawnSync("codex", ["mcp", "login", "unl"], { stdio: "inherit", timeout: 300000 });
      if (login.error) say(`  Codex's \`codex\` command is not on your PATH. Install Codex, then run \`codex mcp login unl\` once.`);
      else if (login.status !== 0) say("  Sign-in to the unl server did not finish. Run `codex mcp login unl` to finish it.");
      else say("  Signed the unl server in with Codex's own sign-in. No key was written into a file.");
    }
  } else {
    if (serverAct) {
      const m = wireClaudeMcp(repo, { url: MCP_URL, headersPath, replace: serverAct === "replace" });
      if (m.ok) say(`  MCP server "unl" ${m.replaced ? "updated in place" : m.kept ? "already there" : "added"} for this project (no second sign-in needed).`);
      else say(`  MCP server not added: ${m.reason}. The hook below still works; add the server later with \`${SELF} connect\`.`);
    } else say("  MCP server: Unl's server is already reachable here, so none was added.");
    if (plan.addHook) {
      const h = wireClaudeHook(repo, hookPath);
      hookAdded = !!h.added;
      say(`  ${h.file}: ${h.added ? "added the hook that serves your decisions on every turn" : "hook already there"}`);
    } else say("  Hook: a hook already serves Unl here, so none was added.");
  }
  if (homeRun) {
    say("  unl.md: not written, because this is your home folder. Run connect again inside a project to add it there.");
  } else {
    say(`  unl.md: ${plan.writeUnlMd && writeUnlMd(repo, path.join(PKG, "templates", "unl.md")) ? "written (how any agent reaches Unl; your decisions stay in Unl)" : "already there, left as is"}`);
    step("Read what you already decided");
    await firstHour(repo, key, flags);
  }

  say("\n" + surfaceTableText());
  say(`\nDone. Open ${agentName} here and work as normal. Unl stays in the background.`);
  say("When you repeat a decision, your agent can offer to keep your exact words. It saves only on your yes.");
  say("Agents starting before sign-in: POST https://api.unlimitless.ai/public/agent-start with JSON words and consent (both verbatim). Give the returned private claim_url to the person to review and Keep within 30 days. Full steps: https://unlimitless.ai/start.md");
  const last = closingLine(surface, { hookAdded });
  if (last) say(last);
}

async function status(rest) {
  // What the free Unl holds here comes first; the hosted Unl's lines follow where any of it is on this machine.
  await freeUnl().run(["status", ...rest]);
  const key = readKey();
  const hookInstalled = fs.existsSync(path.join(HOME, "hook.cjs"));
  if (!key && !hookInstalled) {
    say(`The hosted Unl is not on this machine. \`${SELF} connect\` adds it to a project, when you want it.`);
    return;
  }
  say("");
  say(`Key on this machine: ${key ? ((await keyWorks(key)) ? "present, accepted" : `present, REFUSED (run ${SELF} login to sign in again)`) : `none (run ${SELF} login)`}`);
  say(`Hook runtime: ${fs.existsSync(path.join(HOME, "hook.cjs")) ? "installed" : "not installed"}`);
  const local = path.join(process.cwd(), ".claude", "settings.local.json");
  let wired = false;
  try {
    wired = isUnlHook(fs.readFileSync(local, "utf8"), commandPath(path.join(HOME, "hook.cjs")));
  } catch {}
  say(`Claude Code hook in this folder: ${wired ? "wired" : "not wired"}`);
}

/** The Unl terminal: full screen in a terminal, one line per step in a pipe, a log or with --lines. */
function openTerminal(key, rest, tip) {
  const i = rest.indexOf("--agent");
  const agent = i >= 0 ? String(rest[i + 1] || "").trim() : "";
  // A terminal gets the full-screen view (tui.js); a pipe, a log or --lines gets one line per step.
  if (process.stdout.isTTY && process.stdin.isTTY && !rest.includes("--lines")) return runTui({ api: API, key, agent, tip, self: SELF });
  if (tip) say(tip + "\n");
  return runTerminal({ api: API, key, agent, say, self: SELF, color: !!process.stdout.isTTY && !process.env.NO_COLOR });
}

/**
 * `unl` on its own: with a working key, straight into the terminal. With none it prints the
 * header and the help, and starts no sign-in: the free Unl never asks for one, and signing in
 * is `unl login`'s, on the person's word. A key the server refused says so and names `unl login`. A key
 * the server could not be asked about opens the terminal anyway, which says it is reconnecting.
 */
async function start(rest) {
  const key = readKey();
  const state = key ? await keyState(API, key) : "none";
  if (state === "none" || state === "refused") {
    say(headerText(tuiPaint(colorMode(process.env, !!process.stdout.isTTY), 186), version()));
    if (state === "refused") say(` This machine's key was not accepted (revoked?). Run \`${SELF} login\` to sign in again.\n`);
    say(helpText(SELF));
    return;
  }
  const tip = unwiredProject(process.cwd(), { home: os.homedir() }) ? initOffer(SELF) : "";
  return openTerminal(key, rest, tip);
}

async function login() {
  const key = readKey();
  if (key && (await keyWorks(key))) {
    say(`Already signed in on this machine. Run \`${SELF} logout\` first to sign in as someone else.`);
    return;
  }
  await signInAndStore(undefined, fromOf(process.argv), "");
}

/**
 * Sign out: this machine's key is removed here. It is not revoked, because a key cannot revoke itself
 * over this API; the portal can, and the line says where.
 */
function logout() {
  if (!readKey()) {
    say("Not signed in on this machine.");
    return;
  }
  fs.rmSync(KEY_FILE, { force: true });
  say("Signed out. This machine's key is removed here; to revoke it everywhere, visit unlimitless.ai/portal/keys.");
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = new Set(rest);
  if (!cmd || (cmd.startsWith("--") && !["--version", "--help"].includes(cmd))) return start(process.argv.slice(2));
  if (cmd === "--version" || cmd === "-v" || cmd === "version") return say(version());
  if (cmd === "--help" || cmd === "-h" || cmd === "help") return rest[0] === "local" ? freeUnl().run(["help"]) : say(helpText(SELF));
  // The free Unl: init and the record's own commands run in ../local, exactly as they do there.
  if (cmd === "init") return freeUnl().run(["init", ...rest]);
  if (cmd === "connect") return connect(flags);
  if (cmd === "login") return login();
  if (cmd === "logout") return logout();
  if (cmd === "status") return status(rest);
  if (LOCAL_COMMANDS.includes(cmd)) return freeUnl().run([cmd, ...rest]);
  if (cmd === "terminal") {
    const key = readKey();
    if (!key) throw new Error(`No key on this machine. Run \`${SELF}\` to sign in.`);
    return openTerminal(key, rest, "");
  }
  process.stderr.write(unknownText(cmd, SELF) + "\n");
  process.exitCode = 1;
})().catch((err) => {
  process.stderr.write(`\n${SELF.split(" ").pop()}: ${err && err.message ? err.message : err}\n`);
  process.exitCode = 1;
});
