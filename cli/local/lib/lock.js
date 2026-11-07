"use strict";
/*
 * One writer at a time.
 *
 * The database is real Postgres running inside this process (PGlite). It does not lock its data
 * folder: two processes can open the same folder at once and nothing refuses them (measured on
 * PGlite 0.5.15, a second process opened a folder the first still held). Two Postgres instances on
 * one data folder is how a database is corrupted, so every open of the record goes through this
 * lock, is kept short, and closes before the lock is released.
 *
 * The hooks never take this lock. They read a compiled index and append to a journal, so an agent's
 * action never waits on another agent's write.
 */
const fs = require("fs");
const path = require("path");

const STALE_MS = 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function holderAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/**
 * Take the lock, run `fn`, release it. A lock whose holder has died, or that is older than a minute, is
 * taken over.
 *
 * The lock file appears with its contents already in it: it is written under another name and then
 * linked into place, and a link either happens whole or fails because the lock exists. Creating the
 * file and then writing to it would leave a moment where another process reads it empty, and an empty
 * lock must not be read as "nobody holds this" (found by this package's own test, which caught two
 * holders at once).
 */
async function withLock(lockFile, fn, { timeoutMs = 15000 } = {}) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const started = Date.now();
  const mine = `${lockFile}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  for (;;) {
    try {
      fs.writeFileSync(mine, JSON.stringify({ pid: process.pid, at: Date.now() }));
      try { fs.linkSync(mine, lockFile); } finally { try { fs.unlinkSync(mine); } catch {} }
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let held = null, age = 0;
      try { held = JSON.parse(fs.readFileSync(lockFile, "utf8")); } catch {}
      try { age = Date.now() - fs.statSync(lockFile).mtimeMs; } catch { continue; } // it went away between the two looks: try again
      // A lock that cannot be read is judged by its age alone, never taken at once.
      const stale = held ? !holderAlive(held.pid) || Date.now() - Number(held.at || 0) > STALE_MS : age > STALE_MS;
      if (stale) { try { fs.unlinkSync(lockFile); } catch {} continue; }
      if (Date.now() - started > timeoutMs) throw new Error(`Unl's record is busy${held ? ` (held by process ${held.pid})` : ""}. Try again in a moment.`);
      await sleep(25 + Math.floor(Math.random() * 50));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      const held = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      if (held && held.pid === process.pid) fs.unlinkSync(lockFile);
    } catch {}
  }
}

module.exports = { withLock, holderAlive, STALE_MS };
