"use strict";
/*
 * `unl` on its own — the starter. Neil: "in terminal for claude i just write claude,
 * i want to just write unl, do an oauth the way it works with claude and off we go."
 *
 * ONE PACKAGE, TWO DOORS. `unl
 * init` and the record's commands are the free Unl on this machine (../local), with no account. The
 * hosted Unl is the step up behind `unl login` and `unl connect`. So bare `unl` opens the Unl terminal
 * only on a machine that is already signed in; on one that is not it prints the help, and never starts a
 * sign-in by itself. Signing in never touches the current folder: wiring a project to the hosted Unl is
 * `unl connect`'s job, and the terminal only offers it, in one quiet line.
 *
 * Everything here that decides what to print is pure, so the harness proves it without a network,
 * a browser or a terminal.
 */
const fs = require("fs");
const path = require("path");

const PKG_JSON = path.join(__dirname, "..", "package.json");

function version() {
  try {
    return JSON.parse(fs.readFileSync(PKG_JSON, "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The command a person should type next, as they actually reached this one. Installed with
 * `npm install -g unlimitless` it is `unl`; run through npx it is `npx unlimitless`, because `unl` is not on their
 * PATH and a line telling them to type it would be a dead end. Pure.
 */
function selfCommand(dir = __dirname, env = process.env) {
  const viaNpx = dir.split(path.sep).includes("_npx") || env.npm_command === "exec";
  return viaNpx ? "npx unlimitless" : "unl";
}

/** The short help, Claude Code style. Pure. */
function helpText(self = "unl") {
  const pad = (s) => s.padEnd(self.length + 16);
  return [
    "Unl keeps what you decided and why, and hands it to the AI you work in when it bears.",
    "",
    `Usage: ${self} <command>`,
    "",
    "On this machine, free, with no account and nothing to sign in to:",
    `  ${pad(`${self} init`)}Set Unl up in this project: read your rules files, keep them on your yes, wire your agent.`,
    `  ${pad("")}Wires Claude Code (Cursor runs the same hooks). Add --codex for Codex.`,
    `  ${pad(`${self} status`)}What Unl holds here and what is waiting for you.`,
    `  ${pad(`${self} list`)}The decisions kept for this project. \`${self} why <id>\` gives one in full.`,
    `  ${pad(`${self} keep`)}Keep a decision yourself: ${self} keep "<decision>" --why "<reason>". Also replace, retire.`,
    `  ${pad(`${self} review`)}Go through what is waiting for you.`,
    `  ${pad(`${self} receipt`)}What Unl handed your agent in the latest session.`,
    `  ${pad(`${self} help local`)}Every command of the free Unl.`,
    "",
    "The hosted Unl, the same record in every AI you use (an account, when you want one):",
    `  ${pad(`${self} connect`)}Add the hosted Unl to Claude Code in this project (--cursor for Cursor, --codex for Codex).`,
    `  ${pad(`${self} login`)}Sign in on this machine. \`${self} logout\` removes this machine's key.`,
    `  ${pad(`${self} terminal`)}The Unl terminal: Unl's side of each turn, live. Bare \`${self}\` opens it once you are signed in.`,
    `  ${pad(`${self} up`)}What moves a project up, and the one command that does it.`,
    "",
    `  ${pad(`${self} --version`)}Print the version.`,
    "",
    `connect also takes --dry-run (show what it would change), --repair (update Unl's own entries in place),`,
    `--yes, --no-import and --from <where you came from>. It never adds Unl a second time.`,
    "",
    "More: unlimitless.ai/developers",
  ].join("\n");
}

/** The line an unknown command gets: what went wrong, then the short help. Never a stack trace. Pure. */
function unknownText(cmd, self = "unl") {
  return `${self}: there is no command "${cmd}".\n\n${helpText(self)}`;
}

/**
 * The header a first run opens with: Unl's mark, then one
 * plain line. `mode` is tui.js's colour mode; plain prints no escapes. Pure.
 */
function headerText(paint, ver) {
  return `\n ${paint.mark(" Unl ")} ${paint.dim(`v${ver}`)}\n\n ${paint.bold("Your decisions, with their reasons, in the AI you work in.")}\n`;
}

/** Files that mark a folder as a project someone works in. */
const PROJECT_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "Gemfile", "pom.xml", "build.gradle", "CLAUDE.md", "AGENTS.md"];

/**
 * Does this folder look like a project that is not wired to Unl yet? Only then does the starter offer
 * `init`, once, in one line. The home directory is never a project, whatever it holds. Pure over fs.
 */
function unwiredProject(dir, { home, exists = fs.existsSync, read = (f) => fs.readFileSync(f, "utf8") } = {}) {
  if (home && path.resolve(dir) === path.resolve(home)) return false;
  if (!PROJECT_MARKERS.some((m) => exists(path.join(dir, m)))) return false;
  // Wired means a Unl hook is already there: the one init installs, or a hand-wired one of Unl's own.
  for (const f of [".claude/settings.local.json", ".claude/settings.json", ".cursor/hooks.json"].map((f) => path.join(dir, ...f.split("/")))) {
    try {
      // Either slash: on Windows the path is written with backslashes.
      if (/\.unl[\\/]+hook\.cjs|unl-inject/.test(read(f))) return false;
    } catch {}
  }
  return true;
}

/** The quiet offer, when the folder is a project Unl is not wired into. Pure. */
function initOffer(self = "unl") {
  return `This folder is not wired to the hosted Unl yet. Run \`${self} connect\` here to add it to Claude Code.`;
}

/**
 * Is a stored key still good? Three answers, never two: "ok", "refused" (the server said no, so sign in
 * again), or "unreachable" (no answer at all, so open the terminal anyway and let it reconnect, rather
 * than send someone who is offline through a sign-in that cannot work either).
 */
async function keyState(api, key, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${api}/api/wake`, { headers: { authorization: `Bearer ${key}`, "user-agent": "unl-cli/0.3" } });
    if (res.ok) return "ok";
    // Only a 401 means the key itself is refused. A 403 is a workspace the server will not serve,
    // which a fresh sign-in into the same workspace cannot change.
    return res.status === 401 ? "refused" : "unreachable";
  } catch {
    return "unreachable";
  }
}

module.exports = { version, selfCommand, helpText, unknownText, headerText, unwiredProject, initOffer, keyState, PROJECT_MARKERS };
