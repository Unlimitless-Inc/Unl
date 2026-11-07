"use strict";
/*
 * Take what is private out of text a person is about to share.
 *
 * WHY. A receipt is made to be pasted into a post. The person should be able to paste one without
 * reading it first for a key, a home folder with a name in it, or a customer's address.
 *
 * WHERE THIS SITS. It is the second thing that keeps a receipt clean, not the first. The first is that
 * a receipt is built from parts that cannot carry a secret: the person's own decision and its reason,
 * the name of a file, and the name of a program (see index.js and journal.js). No command line an
 * agent typed is ever printed, because a filter over a command line misses forms nobody listed, and
 * one missed form is a credential in a public post. This file is for what is left: the person's own
 * words, which now and then hold a link with a sign-in in it or a path with their name in it.
 *
 * WHAT IT REMOVES. Secrets by their shape, values assigned to names that sound like secrets, the
 * sign-in inside a link, addresses of people and machines, home folders, and the folders in front of
 * a file name. What it removes it names, so the person is told what was left out and nothing
 * vanishes without a word.
 *
 * WHAT IT CANNOT KNOW. Whether a word is a customer's name, a project's code name, or the name of a
 * machine: "db.internal" reads like "handler.ts". That is why the receipt is shown before it is copied.
 *
 * EVERY PATTERN IS BOUNDED. Each repeat has a ceiling, so the work is in proportion to the text and a
 * long run with no space in it cannot hold a command for minutes, which the first version of these
 * rules did (an eight-kilobyte statement took twenty seconds).
 *
 * Pure. Text in, text and a list out.
 */

/** A value given to a name: quoted, with whatever is inside the quotes, or bare up to the next space. */
const VALUE = "(?:\"[^\"\\n]{1,400}\"|'[^'\\n]{1,400}'|[^\\s\"',;]{4,400})";

/** Each rule: what it is called when it is reported, what it matches, and what is left in its place. */
const RULES = [
  ["a key", /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,8000}?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g, "[key]"],
  ["a key", /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{16,255}/g, "[key]"],
  ["a key", /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,255}/g, "[key]"],
  ["a key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[key]"],
  ["a key", /\bxox[a-z]-[A-Za-z0-9-]{10,255}/g, "[key]"],
  ["a key", /\bwhsec_[A-Za-z0-9+/=_-]{16,255}/g, "[key]"],
  ["a key", /\bAIza[A-Za-z0-9_-]{30,60}/g, "[key]"],
  // A bot token as some chat services write it: digits, a colon, then a long run.
  ["a key", /\b\d{6,12}:AA[A-Za-z0-9_-]{30,40}/g, "[key]"],
  ["a key", /\beyJ[A-Za-z0-9_-]{8,2000}\.[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{4,1000}/g, "[key]"],
  ["a key", /\b(?:npm|pypi|glpat|dop_v1|shpat|unl)[-_][A-Za-z0-9_-]{20,255}/g, "[key]"],
  // The sign-in inside a link. On the web a password holds no slash; a database link's often does, and
  // its user can be empty ("redis://:password@host").
  ["a sign-in", /\b(https?:\/\/)[^\s/:@?#]{0,200}:[^\s/@?#]{1,200}@/gi, "$1"],
  ["a sign-in", /\b((?:postgres(?:ql)?|mysql|mariadb|redis|rediss|mongodb(?:\+srv)?|amqps?|s?ftp|smtps?|ldaps?|mssql|sqlserver|clickhouse|nats|kafka)(?:\+[a-z0-9]{1,20})?:\/\/)[^\s:@]{0,200}:[^\s@]{1,300}@/gi, "$1"],
  // A header that carries a sign-in. After a scheme word anything is the credential; with no scheme it
  // must hold a digit, so "Authorization: role checks live in the middleware" stays a sentence.
  ["a secret", /\b((?:proxy-)?authorization|x-api-key|x-auth-token|x-auth-key|x-access-token)(\s*[:=]\s*)(?:(?:bearer|basic|token|digest)\s+[A-Za-z0-9._~+/=-]{4,4000}|(?=[A-Za-z0-9._~+/=-]{0,400}\d)[A-Za-z0-9._~+/=-]{8,4000})/gi, "$1$2[secret]"],
  ["a secret", /\b(cookie|set-cookie)(\s*:\s*)[^\n=]{0,400}=[^\n]{0,4000}/gi, "$1$2[secret]"],
  ["a secret", /\b(bearer|basic|token)\s+(?=[A-Za-z0-9._~+/=-]{0,400}\d)[A-Za-z0-9._~+/=-]{12,4000}/gi, "$1 [secret]"],
  // A name that sounds like a secret, given a value: NAME=value, name: value, "name":"value".
  ["a secret", new RegExp(`\\b([A-Za-z0-9_.-]{0,40}(?:secret|token|password|passwd|passphrase|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|master[_-]?key|credential)[A-Za-z0-9_.-]{0,40})(["']?\\s*[=:]\\s*)${VALUE}`, "gi"), "$1$2[secret]"],
  // In the environment, a name written in capitals that ends in KEY, PASS and the like is one too (DB_PASS, RAILS_MASTER_KEY).
  ["a secret", new RegExp(`\\b([A-Z][A-Z0-9_]{0,60}(?:KEY|PASS|PWD|SECRET|TOKEN|CREDENTIALS?)[A-Z0-9_]{0,20})(=)${VALUE}`, "g"), "$1$2[secret]"],
  ["a secret", new RegExp(`(--(?:password|passwd|pass|token|secret|client-secret|key|api-key|auth|auth-token|access-token)(?:=|\\s+))${VALUE}`, "gi"), "$1[secret]"],
  // "-u name:password", and a password written hard against "-p".
  ["a secret", /(\s-u\s+)[^\s:]{1,100}:\S{1,200}/g, "$1[secret]"],
  ["a secret", /(\s-p)(?=\S{0,200}[A-Za-z])(?=\S{0,200}\d)\S{6,200}/g, "$1[secret]"],
  ["a long code", /\b[A-Fa-f0-9]{40,512}\b/g, "[code]"],
  ["a long code", /\b[a-z0-9]{40,400}\b/g, "[code]"],
  // A long run with capitals, small letters and digits all in it, and no file ending after it, is a code
  // and not a path. It is taken here, before paths are read, because some keys carry slashes, and a path
  // rule would keep whatever came after the last one.
  ["a long code", /(?<![A-Za-z0-9+/=_-])(?=[A-Za-z0-9+/=_-]{0,400}\d)(?=[A-Za-z0-9+/=_-]{0,400}[a-z])(?=[A-Za-z0-9+/=_-]{0,400}[A-Z])[A-Za-z0-9+/=_-]{32,400}(?![A-Za-z0-9+/=_-]|\.[A-Za-z0-9])/g, "[code]"],
  ["an email address", /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){1,8}/gu, "[email]"],
  ["a machine's address", /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/g, "[address]"],
  ["a link's details", /(\bhttps?:\/\/[^\s?#"'<>)]{1,2000})[?#][^\s"'<>)]{0,4000}/gi, "$1"],
];

/** A run of hex groups and colons that could be a machine's address in the longer form. */
const COLONS = /(?<![A-Za-z0-9:.])[0-9A-Fa-f:]{6,45}(?![A-Za-z0-9:])/g;
/** Whether such a run is an address and not a time of day: it has "::" between groups, or five groups or more. */
function isLongAddress(run) {
  const groups = run.split(":").filter(Boolean);
  if (!groups.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g))) return false;
  if (groups.length >= 5) return true;
  return run.includes("::") && groups.length >= 2;
}

/** A home folder, which has a person's name in it: /Users/name, /home/name, C:\Users\name. */
const HOME = /(?:\/(?:Users|home)|[A-Za-z]:\\Users)[\\/][^\s\\/'"`]{1,80}/g;
/** A whole path inside quotes that starts at the top of a disk or a home folder. Quotes are how a path with a space in it is written. */
const QUOTED_PATH = /(["'`])((?:~|[A-Za-z]:)?[\\/][^"'`\n]{1,400})\1/g;
/** A path with folders in front of a file name, whether it starts at a home folder, a drive letter or inside the project. */
const PATH = /(?:~|[A-Za-z]:|\.{1,2})?(?:[\\/][\w.@+-]{1,120}){2,40}|\b[\w.@+-]{1,120}(?:\/[\w.@+-]{1,120}){1,40}/g;

/**
 * Remove what is private.
 *
 * @param {string} text
 * @param {{ paths?: "name" | "keep" }} [opts]  `paths: "name"` (the default) keeps a file's name
 *        and drops the folders in front of it. `"keep"` leaves paths inside the project as they
 *        are and still drops anything above it.
 * @returns {{ text: string, removed: string[] }}  the text, and what was taken out, each named once
 */
function redact(text, opts = {}) {
  const removed = new Set();
  let out = String(text == null ? "" : text);
  for (const [name, re, to] of RULES) {
    out = out.replace(re, (...m) => {
      removed.add(name);
      return to.replace(/\$(\d)/g, (_x, d) => m[Number(d)] || "");
    });
  }
  out = out.replace(COLONS, (run) => {
    if (!isLongAddress(run)) return run;
    removed.add("a machine's address");
    return "[address]";
  });
  const last = (p) => p.split(/[\\/]/).filter(Boolean).pop();
  out = out.replace(QUOTED_PATH, (_whole, quote, p) => {
    removed.add("a folder on this machine");
    return `${quote}${last(p) || ""}${quote}`;
  });
  out = out.replace(HOME, () => {
    removed.add("a folder on this machine");
    return "~";
  });
  const mode = opts.paths || "name";
  out = out.replace(PATH, (p, at, whole) => {
    // A link is not a path, and neither is a fraction or a date written with slashes.
    const before = whole.slice(Math.max(0, at - 8), at);
    if (/[a-z][a-z0-9+.-]*:\/?$/i.test(before) || /^\/\//.test(p)) return p;
    if (/^[\d/.-]+$/.test(p)) return p;
    const absolute = /^(?:~|[A-Za-z]:|[\\/])/.test(p);
    // "and/or" and "client/server" are words, not paths. Without a folder in front, a path has a file
    // name with an ending, or is at least three parts deep.
    const parts = p.split(/[\\/]/).filter(Boolean);
    if (!absolute && !p.startsWith(".") && parts.length < 3 && !/\.[A-Za-z0-9]{1,8}$/.test(parts[parts.length - 1] || "")) return p;
    if (mode === "keep" && !absolute && !p.startsWith("..")) return p;
    const name = last(p);
    if (absolute) removed.add("a folder on this machine");
    else removed.add("the folders in front of a file name");
    return name || p;
  });
  return { text: out, removed: [...removed] };
}

module.exports = { redact };
