"use strict";
/*
 * Wiring Codex. Codex keeps hooks in the person's own config (~/.codex/config.toml, or $CODEX_HOME),
 * which applies to every project on the machine. That is fine: the hook prints nothing in a project
 * Unl is not set up in. Codex runs a new hook only after the person approves it once, in /hooks, and
 * init says so instead of going round it.
 *
 * Codex reads the same hook output shapes Claude Code does (checked against the schemas in Codex's own
 * source, 0.162). It names file edits differently: one `apply_patch` call carries a whole patch, so the
 * files it touches are read out of the patch text (see hook.cjs).
 *
 * Only ever appended to, and only once. Nothing already in the file is rewritten.
 */
const fs = require("fs");
const path = require("path");

const HOSTED_RX = /\.unl[\\/]+hook\.cjs|unl[-_]inject|unl-codex-serve|api\.unlimitless\.ai/i;
const commandPath = (p, sep = path.sep) => (sep === "\\" ? p.split("\\").join("/") : p);
const codexHome = (home, env = process.env) => (env.CODEX_HOME && env.CODEX_HOME.trim() ? env.CODEX_HOME.trim() : path.join(home, ".codex"));
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };

/** The TOML init appends. A JSON string is a valid TOML basic string, so the command is quoted that way. Pure. */
function hooksToml(hookPath) {
  const cmd = JSON.stringify(`node "${commandPath(hookPath)}" codex`);
  const one = (event, timeout, matcher) => [`[[hooks.${event}]]`, ...(matcher ? [`matcher = ${JSON.stringify(matcher)}`] : []), "", `[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${cmd}`, `timeout = ${timeout}`, ""];
  return ["", "# Unl, on this machine. Added by `npx unlimitless init --codex`. Codex asks you to approve these once, in /hooks.", ...one("UserPromptSubmit", 20), ...one("PreToolUse", 10, "^Bash$|^apply_patch$"), ...one("Stop", 10)].join("\n");
}

/** What is already wired for Codex: { hosted, local, installed }. Reads only. */
function detect(home, { env = process.env, hookPath = null } = {}) {
  const ch = codexHome(home, env);
  const text = [read(path.join(ch, "config.toml")), read(path.join(ch, "hooks.json"))].filter(Boolean).join("\n");
  return { installed: fs.existsSync(ch), hosted: HOSTED_RX.test(text), local: /[\\/]runtime[\\/]+hook\.cjs\\?"\s+codex/.test(text) || (!!hookPath && text.includes(commandPath(hookPath))) };
}

/** Append Unl's hooks to the person's Codex config. Returns { file, added }. */
function wireHooks(home, hookPath, { env = process.env } = {}) {
  const ch = codexHome(home, env);
  const file = path.join(ch, "config.toml");
  const before = read(file) || "";
  if (detect(home, { env, hookPath }).local) return { file, added: false };
  // A config that declares an event as a plain table or an inline array cannot also take an array of tables.
  if (/^\s*(UserPromptSubmit|PreToolUse|Stop)\s*=|^\s*\[hooks\.(UserPromptSubmit|PreToolUse|Stop)\]/m.test(before)) {
    return { file, added: false, reason: "this Codex config declares its hooks in a form that cannot be added to safely, so it was left as it is" };
  }
  fs.mkdirSync(ch, { recursive: true });
  const text = before + (before && !before.endsWith("\n") ? "\n" : "") + hooksToml(hookPath);
  fs.writeFileSync(file, before ? text : text.replace(/^\n/, ""));
  return { file, added: true };
}

module.exports = { detect, wireHooks, hooksToml, codexHome, HOSTED_RX };
