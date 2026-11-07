# Three parts of the open Unl

Three parts that live inside the open Unl. Each is plain CommonJS with no dependencies, runs on Node 18 or later, and takes and returns plain objects, so the install can call them from wherever its own code lives.

| Folder | What it does | Its own page |
|---|---|---|
| [`lib/adr/`](../lib/adr) | Reads a repository's architecture decision records and shows them back as decisions, with the one question only the person can answer. | [adr.md](adr.md) |
| [`lib/share/`](../lib/share) | The receipt Unl leaves when it hands an agent a decision, ready to paste into a post. | [receipt.md](receipt.md) |
| [`lib/telemetry/`](../lib/telemetry) | The opt-in ping. Off until turned on. Four events and nothing else. | [telemetry.md](telemetry.md) |

## How they meet the install

### Decision records

```js
const adr = require("./lib/adr");
const result = adr.readAdrs(repoRoot);        // reads, writes nothing
adr.renderShowBack(result);                   // the text a person sees
result.question;                              // the one question, or null
const proposals = adr.toCandidates(result);   // one per record, for a store to hold
adr.keepable(proposal);                       // false for one that waits on the person or was never decided
```

A proposal carries `key`, `title`, `statement`, `why`, `noReason`, `scope`, `points`, `settled` (`on`, `source`, `by`), `lifecycle`, `replaces`, `replacedBy`, `flags` and `source` (`file`, `lines`, `whyLines`, `digest`).

Keeping is the install's own job. It has one place that builds a kept record and computes its address, and an ADR goes through that place, so there is one copy of that arithmetic.

`lifecycle` says where the record stands. `current` is in force. `replaced`, `retired` and `ruled_out` are history. `proposed` was never decided. `to_settle` and `unclear` wait for the person. `keepable` is false for those and for `proposed` and `ruled_out`, so nothing in doubt is kept by accident.

`settled.on` is the day the record itself gives, which is not the day it was kept in Unl. A receipt shows the first.

When the person answers the question, pass the flag's `id` back as `readAdrs(root, { settled: [id] })` and it is not asked again.

### The receipt

```js
const receipt = require("./lib/share");
const r = receipt.buildReceipt({
  kind: "spoke_first",                        // or "handed"
  at: new Date().toISOString(),
  decision: { statement, why, settledOn, mine }, // its own words; mine is true when the person sharing made it
  about: receipt.describeToolCall(tool, input),
  after: receipt.describeToolCall(nextTool, nextInput),
  crossed: false,                             // true when the agent went ahead anyway
});
receipt.saveReceipt(projectUnlDir, r);        // what is private is already out of it
receipt.renderSession(receipt.readReceipts(projectUnlDir)); // the line for the end of a session
```

`describeToolCall` uses the tool's name, and then the name of the file it pointed at or the name of the program it ran. It never reads the code being written, the folders a file sits in, or the rest of a command line. Where Unl spoke first about a command, `lib/share/journal` gives the decision's own words for it in place of the program.

### The ping

```js
const telemetry = require("./lib/telemetry");
telemetry.record("decision_kept", { count, unlVersion }); // one line to a local queue, never the network
telemetry.record("spoke_first", { unlVersion });
telemetry.noteSession({ unlVersion });                    // "used on a later day", at most once a day
telemetry.flushDetached();                                // sends from a separate process, so a hook returns at once
await telemetry.track("decision_kept", { count });        // for a command the person ran, where a short wait is fine
telemetry.offerLine("unl");                               // the one line a first run may print
```

Every call is a no-op until the person has run `npx unlimitless telemetry on`. Nothing has to be checked first.

### The commands

Each part has a `run(argv, io)` that returns an exit code, for `npx unlimitless adr`, `npx unlimitless receipt` and `npx unlimitless telemetry`.
