"use strict";
/*
 * The receipt Unl leaves when it hands an agent a decision.
 *
 * WHAT IT IS FOR. Unl's value is the mistake that did not happen, and nobody can see that. The
 * receipt is the trace: the decision, its reason, the day it was settled, what the agent was about
 * to do, and what it did next. It is written so a person can paste it into a post with one line of
 * their own, which is how someone else gets to see Unl work without installing anything.
 *
 * WHAT IT WILL AND WILL NOT SAY. It says Unl gave the agent a decision, and it says what the agent
 * did before and after. It never says the agent used the decision or that the decision caused what
 * came next, because a receipt proves what was handed over and the order things happened in, and
 * nothing more. If the agent went ahead anyway, the receipt says that too.
 *
 * WHAT IS IN IT. The person's own decision and reason, and a short line on each side of it. No
 * code, no keys, no addresses, no folders from their machine. What was taken out is named.
 *
 *   describeToolCall(tool, input)   what an agent was about to do, in a few plain words
 *   buildReceipt(event)             the receipt as an object, with what was left out
 *   renderReceipt(receipt, form)    as text, as markdown, or short enough for one post
 *   saveReceipt / readReceipts      the local log the copy command reads from
 *   run(argv, io)                   `unl receipt`, `unl receipt --copy`
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { redact } = require("./redact");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Where the receipt points a reader who wants to try it. */
const HOME_LINE = "Unl: github.com/Unlimitless-Inc/unl";
/** The longest line a receipt carries for what the agent did. Past it the line is cut at a word. */
const MAX_ACT = 160;
/** The longest decision or reason a receipt carries whole. */
const MAX_SAID = 420;
/** How much of a decision or reason is read at all. Far past what is shown, and a bound on the work. */
const MAX_READ = 2000;
/** How many receipts the local log keeps before the oldest are dropped. */
const KEEP = 200;

const oneLine = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

function clip(text, max) {
  const t = oneLine(text);
  if (t.length <= max) return t;
  return t.slice(0, max - 4).replace(/\s+\S*$/, "") + " ...";
}

/** "2026-08-12" as "12 Aug 2026". A month alone is "Aug 2026". Anything else comes back as it was given. */
function sayDate(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (!m) return oneLine(iso);
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return oneLine(iso);
  return m[3] ? `${Number(m[3])} ${month} ${m[1]}` : `${month} ${m[1]}`;
}

/** A file's name, with no folder in front of it. */
function nameOf(file) {
  const parts = String(file || "").split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/** Programs whose next word is the thing they do ("git push", "npm run"), so that word is worth saying. */
const SUBCOMMANDS = new Set([
  "git", "gh", "npm", "pnpm", "yarn", "bun", "npx", "deno", "node", "docker", "kubectl", "helm", "cargo", "go", "pip", "pip3", "poetry", "uv",
  "make", "just", "task", "terraform", "aws", "gcloud", "az", "brew", "apt", "apt-get", "dotnet", "mvn", "gradle", "rails", "rake", "bundle",
  "composer", "turbo", "nx", "prisma", "railway", "vercel", "netlify", "firebase", "supabase", "fly", "flyctl", "heroku", "systemctl",
]);

/**
 * A command as the program it runs and, for the programs that work that way, the one word after it:
 * `git push`, `npm run`, `psql`. NOTHING ELSE OF A COMMAND LINE IS EVER SAID. An agent's command can
 * carry a password in more forms than any list of patterns holds ("-pSecret", "NAME=value program",
 * a link with a sign-in, a cookie), and a receipt is made to be posted. So the part that can hold one
 * is not filtered. It is not read.
 */
function programOf(command) {
  let rest = oneLine(command);
  // Values set in front of a program, and words that only run another one, are not the program. A value
  // in quotes can hold spaces, so it is skipped whole, to its closing quote.
  for (let i = 0; i < 20; i++) {
    const m = /^(?:sudo|env|time|nohup|exec|command)\s+/.exec(rest) || /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"']*)(?:\s+|$)/.exec(rest);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  // A value whose quote never closes (the hooks cut a long command short) leaves no way to tell where the
  // program starts, and a guess could be a word out of a password. So nothing is said.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest)) return "";
  let first;
  const quoted = /^(["'])([^"']*)\1/.exec(rest);
  if (quoted) { first = quoted[2]; rest = rest.slice(quoted[0].length).trim(); }
  else if (/^["']/.test(rest)) return "";
  else { first = rest.split(" ")[0] || ""; rest = rest.slice(first.length).trim(); }
  // A path whose folder name has an escaped space in it stops at the wrong place.
  if (/\\$/.test(first)) return "";
  const program = nameOf(first);
  // A program has a short plain name. Anything else in that place is left unsaid.
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(program)) return "";
  const next = rest.split(" ")[0] || "";
  return SUBCOMMANDS.has(program.toLowerCase()) && /^[a-z][a-z0-9:_-]{0,23}$/.test(next) ? `${program} ${next}` : program;
}

/**
 * What an agent was about to do, from the tool call a hook sees. A few plain words, built only from
 * the tool's name, the name of the file it pointed at, or the name of the program it ran: never the
 * code it was writing, never the folders a file sits in, and never the rest of a command line.
 */
function describeToolCall(tool, input = {}) {
  const t = String(tool || "").toLowerCase();
  const file = nameOf(input.file_path || input.path || input.notebook_path || input.target_file || input.filename || "");
  if (/^(?:edit|multiedit|str_replace|str_replace_editor|apply_patch|update)$/.test(t)) return file ? `edit ${file}` : "edit a file";
  if (/^(?:write|create|create_file)$/.test(t)) return file ? `write ${file}` : "write a file";
  if (/^notebookedit$/.test(t)) return file ? `edit the notebook ${file}` : "edit a notebook";
  if (/^(?:delete|remove|delete_file)$/.test(t)) return file ? `delete ${file}` : "delete a file";
  if (/^(?:bash|shell|run|execute|terminal|run_terminal_cmd|exec)$/.test(t)) {
    const program = programOf(input.command || input.cmd || "");
    return program ? `run \`${program}\`` : "run a command";
  }
  if (/^(?:read|grep|glob|search|ls|list)$/.test(t)) return file ? `read ${file}` : "read the project";
  if (/^(?:webfetch|websearch|fetch)$/.test(t)) return "look something up on the web";
  return tool ? `use ${oneLine(tool).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40) || "a tool"}` : "act";
}

/**
 * Build a receipt from one moment.
 *
 * @param event
 *   kind      "spoke_first" (Unl spoke at the moment the agent was about to act)
 *             or "handed" (Unl gave the decision at the start of the turn)
 *   at        when it happened, ISO
 *   agent     the agent's name as the person knows it ("Claude Code"), or nothing
 *   decision  { title, statement, why, settledOn, mine }  the decision's own words. `mine` is true when the
 *             person sharing the receipt is the one who made it; a receipt says "I settled" only then
 *   about     what the agent was about to do, in a few words
 *   after     what it went to do next, in a few words, or nothing if that was not seen
 *   crossed   true when the agent went ahead anyway
 * @param {{ paths?: "name" | "keep" }} [opts]  how file paths are shown (see redact)
 * @returns the receipt: the same parts with what is private removed, and `leftOut` naming what was removed
 */
function buildReceipt(event, opts = {}) {
  const e = event || {};
  const d = e.decision || {};
  const leftOut = new Set();
  // What is private is taken out of the whole of what is read, and only then is it cut to length: a cut
  // made first can leave half of something the rules would have caught whole.
  const clean = (text, max) => {
    const r = redact(oneLine(text).slice(0, MAX_READ), opts);
    for (const x of r.removed) leftOut.add(x);
    return clip(r.text, max);
  };
  const statement = clean(d.statement || d.title || "", MAX_SAID);
  if (!statement) throw new Error("a receipt needs the decision that was handed over");
  return {
    kind: e.kind === "handed" ? "handed" : "spoke_first",
    at: e.at ? String(e.at) : null,
    agent: e.agent ? oneLine(e.agent).slice(0, 40) : null,
    decision: { statement, why: d.why ? clean(d.why, MAX_SAID) : null, settledOn: d.settledOn ? String(d.settledOn).slice(0, 10) : null, mine: d.mine === true },
    about: e.about ? clean(e.about, MAX_ACT) : null,
    after: e.crossed || !e.after ? null : clean(e.after, MAX_ACT),
    crossed: !!e.crossed,
    leftOut: [...leftOut],
  };
}

const lower = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const stop = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);

/**
 * The receipt as words.
 *
 * @param receipt  from buildReceipt
 * @param {"text" | "markdown" | "short"} [form]  "short" fits one post of 280 characters
 * @param {{ footer?: boolean }} [opts]  `footer: false` leaves off the line that says where Unl is
 */
function renderReceipt(receipt, form = "text", opts = {}) {
  const r = receipt;
  const agent = "my agent";
  // "I settled" is said only where the person sharing is the one who decided. A decision a teammate
  // made arrives through git like any other, and a receipt is not the place to claim it.
  const when = r.decision.settledOn ? sayDate(r.decision.settledOn) : null;
  const settled = r.decision.mine ? (when ? ` I settled on ${when}` : " of mine") : when ? ` settled on ${when}` : " kept for this project";
  const head = r.kind === "handed" ? "Unl gave my agent a decision." : "Unl spoke first.";
  const footer = opts.footer === false ? null : HOME_LINE;

  if (form === "short") {
    const gave = r.kind === "handed" ? ` It was given a decision${settled}:` : ` Unl handed it a decision${settled}:`;
    // What came after is the part a short receipt must never lose: "It went ahead anyway." is the honest
    // half of the story. So the end is fixed first, and what is cut to fit is the decision and then the
    // line on what the agent was about to do. Nothing is ever sliced off the end.
    const then = r.crossed ? " It went ahead anyway." : r.after ? ` Next it went to ${lower(stop(r.after))}` : "";
    const fits = (about, said) => `${head}${about}${gave} "${said}"${then}`;
    let about = r.about ? ` My agent was about to ${lower(r.about)}.` : "";
    if (fits(about, "").length + 40 > 280) about = "";
    const room = Math.max(12, 280 - fits(about, "").length);
    return fits(about, clip(r.decision.statement, room));
  }

  const md = form === "markdown";
  const quote = (s) => (md ? `> ${s}` : `  ${s}`);
  const label = (s) => (md ? `**${s}**` : s);
  const out = [md ? `**${head}**` : head, ""];
  if (r.about) out.push(label(`${agent.charAt(0).toUpperCase()}${agent.slice(1)} was about to`), quote(r.about), "");
  out.push(label(r.kind === "handed" ? `Unl gave it a decision${settled}` : `Unl handed it a decision${settled}`), quote(r.decision.statement));
  if (r.decision.why) out.push(quote(`Why: ${r.decision.why}`));
  out.push("");
  if (r.crossed) out.push(label("It went ahead anyway."), "");
  // The hook sees a call as it is about to be made, so this is what the agent went to do, not proof it was done.
  else if (r.after) out.push(label("What it went to do next"), quote(r.after), "");
  if (footer) out.push(footer);
  return out.join("\n").replace(/\n+$/, "");
}

/** One line for the end of a session: how many decisions were handed over and how often Unl spoke first. */
function renderSession(receipts) {
  const list = receipts || [];
  const handed = new Set(list.map((r) => r.decision.statement)).size;
  const spoke = list.filter((r) => r.kind === "spoke_first").length;
  const crossed = list.filter((r) => r.crossed).length;
  if (!handed) return "";
  const parts = [`Unl gave your agent ${handed} decision${handed === 1 ? "" : "s"}`];
  if (spoke) parts.push(`spoke first ${spoke === 1 ? "once" : spoke === 2 ? "twice" : `${spoke} times`}`);
  let line = parts.join(" and ") + ".";
  if (crossed) line += ` The agent went ahead anyway ${crossed === 1 ? "once" : crossed === 2 ? "twice" : `${crossed} times`}.`;
  return line;
}

/** Where a project's receipts are kept. */
function logPath(dir) {
  return path.join(dir, "receipts.jsonl");
}

/** Add a receipt to the local log. Only the receipt itself is written: it has already had what is private removed. */
function saveReceipt(dir, receipt) {
  fs.mkdirSync(dir, { recursive: true });
  const file = logPath(dir);
  let lines = [];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {}
  lines.push(JSON.stringify(receipt));
  fs.writeFileSync(file, lines.slice(-KEEP).join("\n") + "\n");
  return file;
}

/** The receipts in the local log, oldest first. A line that cannot be read is skipped. */
function readReceipts(dir) {
  let text = "";
  try {
    text = fs.readFileSync(logPath(dir), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.decision && r.decision.statement) out.push(r);
    } catch {}
  }
  return out;
}

/** The command that puts text on the clipboard on this machine, or null when there is none. */
function clipboardCommand(platform = process.platform, env = process.env, has = commandExists) {
  if (platform === "darwin") return has("pbcopy") ? ["pbcopy"] : null;
  if (platform === "win32") return ["clip"];
  if (env.WSL_DISTRO_NAME && has("clip.exe")) return ["clip.exe"];
  if (env.WAYLAND_DISPLAY && has("wl-copy")) return ["wl-copy"];
  if (has("xclip")) return ["xclip", "-selection", "clipboard"];
  if (has("xsel")) return ["xsel", "--clipboard", "--input"];
  if (has("wl-copy")) return ["wl-copy"];
  return null;
}

function commandExists(name) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "ignore" });
  return r.status === 0;
}

/** Put text on the clipboard. Returns whether it worked. */
function copyText(text, cmd = clipboardCommand()) {
  if (!cmd) return false;
  const r = spawnSync(cmd[0], cmd.slice(1), { input: text, stdio: ["pipe", "ignore", "ignore"], timeout: 4000 });
  return r.status === 0;
}

const HELP = [
  "Show the receipt Unl left when it handed your agent a decision, ready to paste into a post.",
  "",
  "Usage: npx unlimitless receipt [number] [--copy] [--short] [--markdown] [--list] [--no-footer]",
  "",
  "  number        which receipt, counting back from the latest (1 is the latest)",
  "  --copy        put it on the clipboard",
  "  --short       short enough for one post of 280 characters",
  "  --markdown    as markdown",
  "  --list        the receipts kept for this project",
  "  --no-footer   leave off the line that says where Unl is",
  "",
  "A receipt carries your decision, its reason and one line on what your agent did. No code, keys or folders.",
].join("\n");

/**
 * The command.
 *
 * @param {string[]} argv  the arguments after `receipt`
 * @param {{ out?: (s: string) => void, dir?: string, copy?: (text: string) => boolean, self?: string }} [io]
 *        `dir` is where this project's receipts are kept.
 */
function run(argv = [], io = {}) {
  const out = io.out || ((s) => process.stdout.write(s + "\n"));
  const self = io.self || "npx unlimitless";
  const args = [...argv];
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  if (flag("--help") || flag("-h")) { out(HELP); return 0; }
  const wantCopy = flag("--copy");
  const form = flag("--short") ? "short" : flag("--markdown") || flag("--md") ? "markdown" : "text";
  const list = flag("--list");
  const footer = !flag("--no-footer");
  const unknown = args.find((a) => a.startsWith("-"));
  if (unknown) { out(`${self} receipt: there is no option "${unknown}".\n\n${HELP}`); return 2; }
  const dir = io.dir || path.join(process.cwd(), ".unl");
  const receipts = readReceipts(dir);
  if (!receipts.length) { out("No receipts yet. Unl leaves one when it hands your agent a decision."); return 0; }

  if (list) {
    const shown = receipts.slice(-20).reverse();
    shown.forEach((r, i) => out(`${String(i + 1).padStart(3)}  ${r.at ? sayDate(String(r.at).slice(0, 10)) : "          "}  ${r.kind === "handed" ? "gave a decision" : "spoke first    "}  ${clip(r.decision.statement, 70)}`));
    const line = renderSession(receipts);
    if (line) out(`\n${line}`);
    return 0;
  }

  const n = args[0] == null ? 1 : Number(args[0]);
  if (!Number.isInteger(n) || n < 1 || n > receipts.length) { out(`${self} receipt: there ${receipts.length === 1 ? "is 1 receipt" : `are ${receipts.length} receipts`}, so ${args[0]} is not one of them.`); return 2; }
  const receipt = receipts[receipts.length - n];
  const text = renderReceipt(receipt, form, { footer });
  out(text);
  if (receipt.leftOut && receipt.leftOut.length) out(`\nLeft out of it: ${receipt.leftOut.join(", ")}.`);
  if (wantCopy) {
    const ok = (io.copy || copyText)(text);
    out(ok ? "\nCopied. Paste it wherever you like." : "\nThis machine has no clipboard command Unl knows, so select the receipt above and copy it.");
    return 0;
  }
  out(`\nCopy it: ${self} receipt${n === 1 ? "" : ` ${n}`}${form === "short" ? " --short" : form === "markdown" ? " --markdown" : ""} --copy`);
  return 0;
}

module.exports = { describeToolCall, programOf, nameOf, buildReceipt, renderReceipt, renderSession, saveReceipt, readReceipts, clipboardCommand, copyText, run, sayDate, logPath, HELP, HOME_LINE };

if (require.main === module) process.exit(run(process.argv.slice(2)));
