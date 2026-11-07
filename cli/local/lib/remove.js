"use strict";
/*
 * Leaving.
 *
 * A tool a person installs in a minute should come out in a minute and leave nothing behind that they
 * did not choose to keep. Removing Unl from a project takes out its hooks and its record. The decisions
 * themselves are the person's, so by default they stay where they are readable: the section in the
 * rules files and the files under .unl/. Asked to, this removes those too, and puts each rules file
 * back to exactly the text the person wrote.
 */
const fs = require("fs");
const path = require("path");
const { store: storePaths, view: viewPaths } = require("./paths");
const { withoutSection, BEGIN } = require("./view");

const LOCAL_HOOK = /[\\/]runtime[\\/]+hook\.cjs"?\s+claude\s*$/;

/** Take Unl's hooks out of the project's Claude Code settings, leaving every other entry as it was. */
function removeClaudeHooks(root) {
  const file = path.join(root, ".claude", "settings.local.json");
  let settings;
  try { settings = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return false; }
  let removed = false;
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    const next = (groups || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => { const mine = LOCAL_HOOK.test(String(h.command || "")); removed = removed || mine; return !mine; }) })).filter((g) => (g.hooks || []).length);
    if (next.length) settings.hooks[event] = next; else delete settings.hooks[event];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  if (!removed) return false;
  if (Object.keys(settings).length) fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  else fs.rmSync(file, { force: true });
  return true;
}

/**
 * Remove Unl from a project. `files: true` also removes the readable decisions and Unl's section in the
 * rules files. Returns what was removed, by name, so the caller can say it.
 */
function remove(project, { files = false } = {}) {
  const done = [];
  if (removeClaudeHooks(project.root)) done.push("the hooks in .claude/settings.local.json");
  const s = storePaths(project.storeDir);
  if (fs.existsSync(s.dir)) { fs.rmSync(s.dir, { recursive: true, force: true }); done.push("the record"); }
  if (files) {
    const v = viewPaths(project.root);
    for (const name of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
      const f = path.join(project.root, name);
      let text;
      try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
      if (!text.includes(BEGIN)) continue;
      const rest = withoutSection(text).replace(/\s+$/, "");
      // A rules file that held nothing but Unl's section goes; one the person wrote in gets their text back.
      if (rest) fs.writeFileSync(f, rest + "\n"); else fs.rmSync(f, { force: true });
      done.push(`Unl's section in ${name}`);
    }
    if (fs.existsSync(v.dir)) { fs.rmSync(v.dir, { recursive: true, force: true }); done.push(".unl/"); }
  }
  return done;
}

module.exports = { remove, removeClaudeHooks };
