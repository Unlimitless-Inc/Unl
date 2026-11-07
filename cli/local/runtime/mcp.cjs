#!/usr/bin/env node
"use strict";
/*
 * Unl's local MCP server: the tools an agent can call. It speaks MCP over stdio and runs on this
 * machine, against this project's record. It makes no network connection.
 *
 * THREE TOOLS, AND WHAT NONE OF THEM CAN DO.
 *   decisions   read the kept decisions that bear on a task, with their reasons
 *   why         read one decision in full: its reason, who decided, what it replaced
 *   propose     put something forward to be kept, or to replace a kept decision
 *
 * There is no tool that keeps a decision, and that is the design, not a gap. Only the person makes a
 * decision. What an agent proposes waits, inert, until the person says yes in their own words (the
 * hook sees those words itself) or keeps it at the command line. An agent's word that "the person
 * agreed" is not evidence, so no tool accepts it.
 */
const path = require("path");
const LIB = path.join(__dirname, "..", "lib");

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const TOOLS = [
  {
    name: "decisions",
    description: "Read the decisions kept for this project, each with its reason and who decided it. Pass what you are about to work on as `about` to get the ones that bear on it, or leave it out to get them all. They are settled choices made by a person, never by an agent: work from them, and if a task goes against one, say so before acting.",
    inputSchema: { type: "object", properties: { about: { type: "string", description: "What you are about to do, in plain words. A file path or command may be included." } }, additionalProperties: false },
    annotations: { readOnlyHint: true, title: "Read kept decisions" },
  },
  {
    name: "why",
    description: "Read one kept decision in full: its reason, who decided it and when, where it came from, what it replaced and whether it has since been replaced. Pass the id shown beside the decision.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "The decision's id, or the first characters of it." } }, required: ["id"], additionalProperties: false },
    annotations: { readOnlyHint: true, title: "Read one decision" },
  },
  {
    name: "propose",
    description: "Put a decision forward for this person to keep. Use it when they settle something worth keeping, or when a kept decision should change (pass the id it would replace). Nothing is kept by this call: it waits until the person says yes. After calling it, ask them in one line whether to keep it, and why if no reason was given.",
    inputSchema: {
      type: "object",
      properties: {
        decision: { type: "string", description: "The decision, in the person's own words where you have them." },
        why: { type: "string", description: "The reason, if the person gave one. Never make one up." },
        replaces: { type: "string", description: "The id of a kept decision this would take the place of." },
        model: { type: "string", description: "The model you are, as you would name it. Optional." },
      },
      required: ["decision"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, title: "Propose a decision" },
  },
];

function project(root) {
  const paths = require(path.join(LIB, "paths"));
  const p = paths.locate(root || process.cwd());
  if (!paths.isSetUp(p)) throw new Error("Unl is not set up in this project. The person can run `npx unlimitless init` in it.");
  return p;
}

async function call(name, args, root) {
  const { shortId } = require(path.join(LIB, "format"));
  const { day } = require(path.join(LIB, "view"));
  const store = require(path.join(LIB, "store"));
  const p = project(root);
  const one = (d) => `[${shortId(d.id)}] ${d.statement}\n  The reason: ${d.why || "none was given."}\n  Kept ${day(d.ratified_at)} by ${d.ratified_by}.`;
  if (name === "decisions") {
    const about = String((args && args.about) || "").trim();
    return store.withStore(p.storeDir, async (db) => {
      const rows = about ? await store.searchDecisions(db, about, 12) : await store.listDecisions(db, { status: "canonical" });
      if (!rows.length) return about ? "Nothing kept for this project bears on that. That is an answer, not a fault: there is no decision to follow here." : "No decisions are kept for this project yet.";
      const shown = rows.slice(0, 40);
      return `${shown.length} ${shown.length === 1 ? "decision" : "decisions"} kept for this project${about ? (shown.length === 1 ? " that bears on this" : " that bear on this") : ""}:\n\n${shown.map(one).join("\n\n")}${rows.length > shown.length ? `\n\n${rows.length - shown.length} more are kept. Ask with \`about\` to get the ones that bear.` : ""}`;
    });
  }
  if (name === "why") {
    return store.withStore(p.storeDir, async (db) => {
      const { decision: d, matches } = await store.findDecision(db, args && args.id);
      if (!d) return matches > 1 ? "That id matches more than one decision. Use more of it." : "No decision has that id.";
      const all = await store.listDecisions(db);
      const lines = [one(d)];
      if (d.source && d.source.file) lines.push(`  Read from ${d.source.file}, line ${d.source.line_start}.`);
      for (const rid of d.record.provenance.wasRevisionOfAll || []) { const o = all.find((x) => x.ruling_id === rid); if (o) lines.push(`  It replaced: "${o.statement}" (kept ${day(o.ratified_at)}).`); }
      if (d.status === "superseded") { const by = all.find((x) => x.id === d.replaced_by); lines.push(by ? `  THIS ONE NO LONGER STANDS. It was replaced ${day(d.replaced_at)} by [${shortId(by.id)}] "${by.statement}"` : `  THIS ONE NO LONGER STANDS. It was retired ${day(d.replaced_at)}.${d.retired_why ? " " + d.retired_why : ""}`); }
      return lines.join("\n");
    });
  }
  if (name === "propose") {
    const decisions = require(path.join(LIB, "decisions"));
    const { refreshIndex } = require(path.join(LIB, "index"));
    const { triggers, titleOf } = require(path.join(LIB, "extract"));
    const text = String((args && args.decision) || "").trim();
    if (text.length < 8) return "A proposal needs the decision itself, in a sentence.";
    return store.withStore(p.storeDir, async (db) => {
      let replaces = [];
      if (args.replaces) {
        const { decision, matches } = await store.findDecision(db, args.replaces);
        if (!decision) return matches > 1 ? "The id to replace matches more than one decision. Use more of it." : "No kept decision has the id you want to replace.";
        if (decision.status !== "canonical") return "That decision has already been replaced.";
        replaces = [decision.id];
      }
      const { proposal, added } = await decisions.propose(db, { title: titleOf(text), content: text, why: args.why || null, applies_to: triggers(text), replaces, proposed_by: String(args.model || "an agent").slice(0, 80), source: { said: "proposed by an agent" } });
      const row = (await store.findProposal(db, proposal.id)).proposal;
      await refreshIndex(db, p.storeDir);
      if (!added && row && row.status === "skipped") return "The person was already asked about this and said no. It was not proposed again.";
      if (!added && row && row.status === "kept") return "This is already kept.";
      return `Proposed, not kept: [${shortId(proposal.id)}] "${proposal.content}"${replaces.length ? " (it would replace a kept decision)" : ""}.\nOnly the person can keep it. Ask them in one line whether to keep it${args.why ? "" : ", and why"}. Their yes, in their own words, is what keeps it. They can also run \`npx unlimitless keep ${shortId(proposal.id)}\`.`;
    });
  }
  throw new Error(`there is no tool "${name}"`);
}

function main(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--root");
  const root = i >= 0 ? argv[i + 1] : null;
  const pkg = require(path.join(__dirname, "..", "package.json"));
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  let buf = "";
  let chain = Promise.resolve();
  const handle = async (msg) => {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return;
    const reply = (result) => msg.id !== undefined && send({ jsonrpc: "2.0", id: msg.id, result });
    const error = (code, message) => msg.id !== undefined && send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
    try {
      if (msg.method === "initialize") {
        const asked = msg.params && msg.params.protocolVersion;
        return reply({ protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: { name: "unl", version: pkg.version }, instructions: "Unl holds what this person decided for this project and why, on their own machine. Read `decisions` before acting on something they may have settled. Use `propose` when something worth keeping is settled; only they can keep it." });
      }
      if (msg.method === "ping") return reply({});
      if (msg.method === "tools/list") return reply({ tools: TOOLS });
      if (msg.method === "tools/call") {
        const name = msg.params && msg.params.name;
        try {
          const text = await call(name, (msg.params && msg.params.arguments) || {}, root);
          return reply({ content: [{ type: "text", text }] });
        } catch (e) {
          return reply({ content: [{ type: "text", text: `Unl could not do that: ${e && e.message ? e.message : e}` }], isError: true });
        }
      }
      if (msg.method.startsWith("notifications/")) return;
      return error(-32601, `method not found: ${msg.method}`);
    } catch (e) {
      return error(-32603, String(e && e.message ? e.message : e));
    }
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); continue; }
      // One request at a time: each opens the record, and the record takes one writer.
      chain = chain.then(() => handle(msg));
    }
  });
  process.stdin.on("end", () => chain.then(() => process.exit(0)));
}

if (require.main === module) main();
module.exports = { main, call, TOOLS };
