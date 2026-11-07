"use strict";
/*
 * Wiring Claude Code. Everything written here is per person and per machine
 * (.claude/settings.local.json, and Claude Code's own local-scope MCP list), never a file a teammate
 * would pick up from the repository: the hook runs from a path in this person's home folder.
 * Idempotent: running it twice changes nothing the second time.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// `Shell` is Cursor's name for the same thing: Cursor runs these hooks too and matches on its own tool names.
const TOOLS = "Bash|Shell|Edit|Write|MultiEdit|NotebookEdit";
/** A hook that reaches the hosted Unl. Where one is already wired, the local hooks are not added beside it. */
const HOSTED_RX = /\.unl[\\/]+hook\.cjs|unl[-_]inject|unl-codex-serve|api\.unlimitless\.ai/i;
const LOCAL_RX = /[\\/]runtime[\\/]+hook\.cjs/;
const commandPath = (p, sep = path.sep) => (sep === "\\" ? p.split("\\").join("/") : p);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
    if (e.code === "ENOENT") return {};
    throw new Error(`${file} is not valid JSON, so it was left untouched. Fix it and run init again.`);
  }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

const commandsIn = (settings) => Object.values((settings && settings.hooks) || {}).flatMap((groups) => (groups || []).flatMap((g) => (g.hooks || []).map((h) => String(h.command || ""))));

/** What is already wired in this folder: { hosted, local }. Reads only. */
function detect(root, { home }) {
  const files = [path.join(root, ".claude", "settings.json"), path.join(root, ".claude", "settings.local.json"), path.join(home, ".claude", "settings.json")];
  const cmds = files.flatMap((f) => { try { return commandsIn(JSON.parse(fs.readFileSync(f, "utf8"))); } catch { return []; } });
  return { hosted: cmds.some((c) => HOSTED_RX.test(c)), local: cmds.some((c) => LOCAL_RX.test(c) && /\bclaude\s*$/.test(c)) };
}

/** Add Unl's four hooks to .claude/settings.local.json. Returns { file, added }. */
function wireHooks(root, hookPath) {
  const file = path.join(root, ".claude", "settings.local.json");
  const settings = readJson(file);
  const cmd = `node "${commandPath(hookPath)}" claude`;
  settings.hooks = settings.hooks || {};
  let added = false;
  const add = (event, group) => {
    const groups = (settings.hooks[event] = settings.hooks[event] || []);
    const want = group.hooks[0].timeout;
    const mine = groups.flatMap((g) => g.hooks || []).filter((h) => String(h.command || "") === cmd);
    if (mine.length) {
      // Already wired. A limit shorter than Unl now needs is lengthened; nothing else about it is touched.
      for (const h of mine) if (!(Number(h.timeout) >= want)) { h.timeout = want; added = true; }
      return;
    }
    groups.push(group);
    added = true;
  };
  // Before an action Unl may wait on one short turn of the person's own agent (lib/judge.js), so the
  // limit there is the same as at the ask, and longer than the longest that turn is given.
  add("UserPromptSubmit", { hooks: [{ type: "command", command: cmd, timeout: 20 }] });
  add("PreToolUse", { matcher: TOOLS, hooks: [{ type: "command", command: cmd, timeout: 20 }] });
  add("Stop", { hooks: [{ type: "command", command: cmd, timeout: 10 }] });
  // The one line a session is said as the next one starts, because Claude Code shows nothing a hook says as a session ends.
  add("SessionStart", { hooks: [{ type: "command", command: cmd, timeout: 10 }] });
  if (added) writeJson(file, settings);
  return { file: path.relative(root, file), added };
}

/** Remove Unl's hooks again, leaving everything else in the file as it was. */
function unwireHooks(root, hookPath) {
  const file = path.join(root, ".claude", "settings.local.json");
  let settings;
  try { settings = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { file: path.relative(root, file), removed: false }; }
  const cmd = `node "${commandPath(hookPath)}" claude`;
  let removed = false;
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    const next = (groups || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => { const mine = String(h.command || "") === cmd; removed = removed || mine; return !mine; }) })).filter((g) => (g.hooks || []).length);
    if (next.length) settings.hooks[event] = next; else delete settings.hooks[event];
  }
  if (removed) writeJson(file, settings);
  return { file: path.relative(root, file), removed };
}

/** Add the local MCP server to Claude Code's own local scope for this folder. Needs the `claude` command. */
function wireMcp(root, mcpPath, { bin = "claude" } = {}) {
  const run = (args) => spawnSync(bin, args, { cwd: root, encoding: "utf8", timeout: 60000 });
  const probe = run(["--version"]);
  if (probe.error || probe.status !== 0) return { ok: false, reason: "the `claude` command is not on your PATH" };
  if (run(["mcp", "get", "unl"]).status === 0) return { ok: true, kept: true };
  const config = JSON.stringify({ type: "stdio", command: "node", args: [commandPath(mcpPath), "--root", root] });
  const add = run(["mcp", "add-json", "unl", config, "-s", "local"]);
  if (add.status !== 0) return { ok: false, reason: `${add.stderr || add.stdout || ""}`.trim().split("\n").pop() || "claude mcp add-json failed" };
  return { ok: true, kept: false };
}

module.exports = { detect, wireHooks, unwireHooks, wireMcp, commandPath, TOOLS, HOSTED_RX, LOCAL_RX };
