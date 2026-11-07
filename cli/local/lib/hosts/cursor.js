"use strict";
/*
 * Wiring Cursor.
 *
 * Cursor runs Claude Code's hooks by default (its "third-party imports" setting, on unless switched
 * off) and reads Claude Code's response format, so a project wired for Claude Code is already served
 * in Cursor through the same three hooks. This file is for a person who uses Cursor and not Claude
 * Code: it writes the same hook into Cursor's own user file, ~/.cursor/hooks.json.
 *
 * The command string is the same one the Claude Code wiring uses, on purpose. Cursor runs a hook once
 * when the imported one and its own are identical; a different string would run Unl twice a turn.
 *
 * Run live on the Cursor CLI (2026.10.18) with the hook wired both ways at once: it ran once per event,
 * an edit was allowed with its decision handed over, and a command a decision says to avoid was stopped
 * with the decision as the reason, which the agent then gave the person. The prompt hook did not fire in
 * a headless run, so handing decisions over at the prompt is not proven for Cursor.
 */
const fs = require("fs");
const path = require("path");

const commandPath = (p, sep = path.sep) => (sep === "\\" ? p.split("\\").join("/") : p);
const cursorHome = (home, env = process.env) => (env.UNL_CURSOR_HOME && env.UNL_CURSOR_HOME.trim() ? env.UNL_CURSOR_HOME.trim() : path.join(home, ".cursor"));

function wireHooks(home, hookPath, { env = process.env } = {}) {
  const file = path.join(cursorHome(home, env), "hooks.json");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
    if (e.code !== "ENOENT") return { file, added: false, reason: "this file is not valid JSON, so it was left as it is" };
  }
  cfg.version = cfg.version || 1;
  cfg.hooks = cfg.hooks || {};
  const cmd = `node "${commandPath(hookPath)}" claude`;
  let added = false;
  const add = (event, extra = {}) => {
    const list = (cfg.hooks[event] = cfg.hooks[event] || []);
    if (list.some((h) => h && h.command === cmd)) return;
    list.push({ command: cmd, ...extra });
    added = true;
  };
  add("beforeSubmitPrompt", { timeout: 20 });
  add("preToolUse", { matcher: "Shell|Write", timeout: 10 });
  add("stop", { timeout: 10 });
  if (added) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n"); }
  return { file, added };
}

module.exports = { wireHooks, cursorHome };
