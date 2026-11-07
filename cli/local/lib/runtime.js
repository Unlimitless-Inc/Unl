"use strict";
/*
 * This machine's copy of Unl.
 *
 * Hooks and the MCP server are started by the agent, long after `npx` has finished, and the place npx
 * unpacked the package to is a cache that can be emptied at any time. So `init` copies what they need
 * (this package's own code and its database engine) into ~/.unl/open, and the hooks run from there.
 * Nothing else is ever put in that folder: no key, no account, no record. The record lives with the
 * project (see paths.js).
 */
const fs = require("fs");
const path = require("path");
const { runtimeHome } = require("./paths");

const PKG = path.join(__dirname, "..");

function copyDir(from, to, skip = () => false) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (skip(a, e)) continue;
    if (e.isDirectory()) copyDir(a, b, skip);
    else if (e.isFile()) fs.copyFileSync(a, b);
  }
}

/** Where the database engine is installed, as this copy of the package can reach it. */
function pgliteDir() {
  try { return path.dirname(require.resolve("@electric-sql/pglite/package.json", { paths: [PKG] })); } catch {}
  let p;
  try { p = require.resolve("@electric-sql/pglite", { paths: [PKG] }); } catch { return null; }
  let d = path.dirname(p);
  while (d !== path.dirname(d)) { if (fs.existsSync(path.join(d, "package.json")) && path.basename(d) === "pglite") return d; d = path.dirname(d); }
  return null;
}

/**
 * Put the runtime in place and return where the hook and the server are. With `inPlace` the package's
 * own files are used where they stand (for development and for a global install that will not move).
 */
function install({ env = process.env, inPlace = false } = {}) {
  if (inPlace || env.UNL_OPEN_IN_PLACE === "1") return { home: PKG, hook: path.join(PKG, "runtime", "hook.cjs"), mcp: path.join(PKG, "runtime", "mcp.cjs"), copied: false };
  const home = runtimeHome(env);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const d of ["lib", "runtime", "bin"]) copyDir(path.join(PKG, d), path.join(home, d));
  fs.copyFileSync(path.join(PKG, "package.json"), path.join(home, "package.json"));
  const pg = pgliteDir();
  if (!pg) throw new Error("Unl's database engine (@electric-sql/pglite) was not found beside this package. Reinstall with `npx unlimitless init`.");
  // Source maps are for people debugging the engine, and are most of its size.
  copyDir(pg, path.join(home, "node_modules", "@electric-sql", "pglite"), (a, e) => e.isFile() && a.endsWith(".map"));
  return { home, hook: path.join(home, "runtime", "hook.cjs"), mcp: path.join(home, "runtime", "mcp.cjs"), copied: true };
}

module.exports = { install, pgliteDir, PKG };
