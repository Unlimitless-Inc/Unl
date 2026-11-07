# Unl

Unl keeps what you decided and why, on your own machine, and hands it to your coding agent when it bears.

Never update your CLAUDE.md again.

```bash
npx unlimitless init
```

Run it in a project. There is no account, no key and nothing to sign in to, at install or in use.

It needs Node.js 20 or later, which is what puts `npx` on your machine. Every command below runs through `npx unlimitless`, so nothing has to be installed first.

Every decision is kept in the open [kept-decision format](../decision-format), which any tool can read and check.

## The first minute

Unl reads the rules you already wrote for your agents (CLAUDE.md, AGENTS.md, Cursor rules and the like) and shows them back to you as decisions. You say yes once and they are kept, in your own words.

```text
Reading what you already wrote down
  CLAUDE.md  6 rules, 4 with a reason
  AGENTS.md  1 rule, 0 with a reason

Keep these 7 as your decisions? Your wording is kept exactly. [Y/n]

Kept 7 decisions, as decided by pat@example.com.

Two of them cannot both hold
  1. "Use pnpm, never npm"  (CLAUDE.md, line 4)
  2. "Use npm to install packages"  (AGENTS.md, line 3)
  Which stands? [1/2/skip]

One names something that is not here
  "Never edit src/generated/schema.ts by hand" names `src/generated/schema.ts`, which is not in this project.

3 decisions have no reason yet. The reason is what lets an agent get the next case right.
```

A line that only says what the project is, or where something lives, is kept as well and told apart from the rules. It is handed to your agent only when the work in front of it touches what the line describes.

Then it does what a file cannot do for itself. It tells you which decisions give no reason, which two cannot both hold, and which name a file or a script that is gone. If two cannot both hold it asks you which one stands, because only you can answer that. If it finds nothing, it says nothing.

## After that, you should not notice it

Unl works inside the agent you already use. Most of the time it does nothing and prints nothing. There are four moments when it does something.

**It hands your agent the decisions that bear on what you asked.** Not the whole file, and nothing at all when nothing bears.

**It speaks first when your agent is about to do the thing you decided against.** This is from a real session on Claude Code. The person had kept "Never `git add -A`. Stage the paths you actually edited." and then told the agent to run it anyway.

```text
> Bash  git add -A && git commit -m 'add notes'

Unl is speaking before this happens. This was decided for this project on 6 Nov 2026 by pat@example.com:
"Never `git add -A`. Stage the paths you actually edited."
The reason: In a shared tree it picks up other people's work.
The command `git add -A && git commit -m 'add notes'` is what that decision is about.
Unl stopped this one call so the decision reaches you before the action and not after. It has not
forbidden anything: the same call made again goes through, and the receipt for this session will
say that it did.
```

**It notices when you state a rule, and asks once whether to keep it.** You answer in your own words, and your answer is what keeps it.

```text
you   From now on, commit messages in this repo start with a ticket number like ABC-123.
Unl   That reads as a decision. Reply "keep" with one line on why and it is kept for next time, or "skip".
you   keep, because our changelog is generated from them
Unl   Kept "Commit messages in this repo start with a ticket number like ABC-123".
```

**It leaves one line a session,** saying what it handed over and what happened next. Nothing is said when a turn ends. Claude Code shows nothing a hook says as a session closes, so the line for a session is said once when you next start one in the project.

```text
In your last session here, Unl gave your agent 1 decision and spoke first once. After Unl spoke, the agent went ahead once.
```

`npx unlimitless receipt` reads the latest session at any time. Codex and Cursor are not handed this line, so there `npx unlimitless receipt` is the way to read it.

The receipt says what Unl gave your agent. It never says your agent used it, because a record of what was handed over cannot prove why the agent did what it did.

If you explain something again that is already kept, Unl tells you when it was kept and that your agent already has it. If what you say changes a kept decision, Unl asks whether the new one replaces the old one, and marks the old one as replaced when you say yes.

## Your rules files keep themselves current

Unl writes one section, between its own markers, into AGENTS.md, and into CLAUDE.md where you have one or use Claude Code, since that is the file Claude Code reads. Every tool that reads those files gets your decisions with nothing to connect.

```markdown
## Decisions

- **Use `pnpm`, never `npm`.** Why: The lockfile is pnpm-lock.yaml. _(kept 14 Oct 2026)_
- **Exports run on a background queue, not inside the request.** Why: Larger files exceed the request timeout. _(kept 6 Nov 2026)_

### Replaced

- ~~Exports run synchronously inside the request.~~ Replaced 6 Nov 2026 by "Exports run on a background queue, not inside the request".
```

Unl writes only between its markers. Whatever you or another tool wrote in the file stays exactly as it was. Where a line you wrote by hand has since been replaced, the section says so.

It also writes one readable file per decision into `.unl/decisions/`. Commit them. A teammate who pulls and runs the same one command gets the same decisions.

## What is on your machine, and what leaves it

Unl itself sends nothing, unless you turn on the ping described under Telemetry below. It is off until you do. With it off the package makes no network connection, and its tests fail if any part of it ever tries to. The one folder that can send anything is the ping's own, and its tests fail if it sends before you have turned it on.

To choose which decisions bear, Unl asks the agent you already run, for one short turn. What it shows that agent is your decisions, what you asked and the lines about to be written. That goes where your agent's prompts already go and nowhere else, and your agent is shown all three anyway. `npx unlimitless judge off` stops it, and Unl then goes by the words of what you ask.

| What | Where | In git |
|---|---|---|
| The record, a real Postgres database | `.git/unl/` in the project | never |
| One readable file per decision | `.unl/decisions/` | yes, on purpose |
| Unl's section in your rules files | AGENTS.md, CLAUDE.md | yes |
| The hook and the local server | `~/.unl/open/` | no |

The record is Postgres because a decision is more than a line of text. It has a reason, a date, the person who made it, what it applies to, what it replaced and what replaced it. The files are written from the record so they can be read by people and by every tool.

Because the record sits in the repository's own git folder, every worktree of a clone shares it. Several agents working in several worktrees work from the same decisions.

## If you already keep decision records

Unl reads the architecture decision records a project keeps (an ADR folder such as `docs/adr` or `docs/decisions`) as the decisions they are. `npx unlimitless init` finds the folder, shows the records back with what replaced what, and keeps them on the same yes as your rules files, each with the day its own record gives. A record that was replaced is kept as replaced, so your agent is told what took its place and is never handed the old one as current. A record that was only proposed, was rejected, or has a status Unl cannot read is shown and not kept.

If the records disagree with each other, Unl asks the one question that most needs you and leaves the rest for later. `npx unlimitless adr` shows the records and that question at any time, and changes nothing. [docs/adr.md](local/docs/adr.md) has the forms it reads and everything it checks.

## Showing someone

When Unl speaks first, the receipt for that moment can be pasted into a post as it is.

```bash
npx unlimitless receipt --copy
```

It carries the decision, its reason, the day it was settled, what your agent was about to do and what it went to do next. It never carries a command line your agent typed: for a command it gives your decision's own words for it, or the name of the program, and for a file its name. Your own words are read once more for keys, addresses and home folders, and Unl says what it took out. [docs/receipt.md](local/docs/receipt.md) shows one.

## Telemetry

Unl can send an anonymous ping so the people who make it can tell whether it is any use.
It is off until you turn it on.

It sends four things and nothing else.

- that Unl was installed (once, when you turn this on)
- that you kept a decision, and how many (a number, never the words)
- that Unl spoke first before your agent acted, and how many times
- that Unl was used on a later day (at most once a day)

With each one go the version of Unl and a random id made on this machine. It never sends your decisions, their reasons, your code, file names, folder names, project names, prompts, your name or your email.

```bash
npx unlimitless telemetry          # what it sends, and whether it is on
npx unlimitless telemetry on       # turn it on
npx unlimitless telemetry off      # turn it off
npx unlimitless telemetry show     # every ping from this machine, exactly as it went
npx unlimitless telemetry reset    # replace the random id
```

Setting `DO_NOT_TRACK=1` stops it, and it never sends from CI. [docs/telemetry.md](local/docs/telemetry.md) is the whole of it, including the one line a ping consists of.

## Only you make a decision

An agent can propose a decision. It cannot keep one. There is no tool that lets it, and that is the design.

- What Unl reads from a file is a proposal until you say yes.
- What an agent proposes is a proposal until you say yes.
- Your yes is read from what you typed, by Unl itself. An agent saying "they agreed" is not evidence and nothing accepts it.
- A flag is not a person. Run with nobody at a terminal, `npx unlimitless init --yes` keeps nothing, and Unl asks you once in your agent.
- The commands that keep, replace and retire run only at a terminal, and Unl speaks first if an agent tries one.
- Every kept decision names the person who made it and when, and carries an address computed from its contents. Anyone holding the file can recompute the address and know it has not been altered.

See [SECURITY.md](local/SECURITY.md) for the whole of it, including what has not been tested yet.

## Four things that have to be true, and where each stands

**1. What you decided never gets mixed up with what something else suggested.** Built as above. A web page, an agent's suggestion and your settled decision are different kinds of row and only your yes turns one into another. It is tested against planted words: a proposal claiming you agreed, pasted text, a flag with nobody there, an agent's own shell. It is not a sandbox, and [SECURITY.md](local/SECURITY.md) says where that line is.

**2. What bears arrives and the rest stays out.** Unl gathers the decisions that might bear with no model, and then asks the agent you already run which of them do. That agent's model answers with which ones and never with words of its own, so what your agent is handed is your decision and your reason exactly as you kept them. What bears is handed in full. What might bear is handed as one line. A decision the work names outright is never left out, and whether an action crosses a decision is decided by Unl itself, at once, with no model. A rule that applies to every change, such as how commits are written, is left to the rules file your agent already reads on every turn. A development reading on 20 public repositories Unl had never seen (not a release test) took the 200 pieces of real work in them that a kept decision bore on. Of the 358 decisions that bore, 302 reached the agent when the ask was long and 300 when it was one line, which is a little over 8 in 10. The words of the ask alone had reached about 2 in 10. About 3 in 10 of what it handed on that work bore. How often it stays quiet on work nothing bears on has not been read for this build. So it finds most of what bears and still hands over more than it should, and it does not claim otherwise. If your agent's model cannot be asked, Unl hands what the work plainly names in full and the nearest others as one line each, never your whole record, and tells you once. `npx unlimitless serve --prompt "..."` shows what Unl would hand over for any prompt, file or command, and why, and `npx unlimitless serve --candidates` shows the wider list that is chosen from.

**3. A change reaches an agent that is already working.** When a decision an agent was handed is replaced, that agent is told on its very next action, with what replaced it and which files it has touched since. This works wherever Unl's hooks run. An agent on a tool without hooks keeps the earlier version until it next reads the rules file.

**4. Unl says what was decided. The tool your agent runs in says what is allowed.** Unl never grants or refuses permission. When it speaks first it stops one call, once, so the decision arrives before the action, and the same call goes through the second time. Use it beside your tool's own permission settings, never in place of them.

## Which agents

| Agent | What works | How it was checked |
|---|---|---|
| Claude Code | all four moments | run live on Claude Code 2.1.319, including the line a session, said at the start of the next one |
| Codex | the first three moments; the line a session through `npx unlimitless receipt` | run live on Codex 0.162.0, each time with the rule taken out of the rules file so the hook was the only way the agent could learn it. Asked to edit a generated file by hand and to stage with `git add -A`, the agent was handed both decisions at the prompt, said so, and did it the kept way instead. Asked only to stage everything, it tried `git add -A`, Unl spoke first with the decision and its reason, and because the person had asked for everything it said so and went ahead. In one run the agent wrote the command as `git add --all`, which Unl did not then see as the same command. It does now |
| Cursor | decisions handed before an edit or a command, and speaking first | run live on the Cursor CLI 2026.10.18 for edits and commands. Its prompt hook did not fire in a headless run, so that part is not proven there |
| Anything that reads AGENTS.md | the decisions, through the file | by the file itself |

`npx unlimitless init` wires Claude Code, and Cursor runs the same hooks. Add `--codex` for Codex.

Which decisions bear is chosen by your agent's own model where that model can answer in time. On Claude Code that is at each ask, and the first time a file is about to change in a turn. On Codex it is at each ask. On Claude Code 2.1.319 this was run in whole live sessions, with the rules files emptied so the hook was the only way the agent could learn a decision. Asked to rename a function, nothing bore and Unl said nothing, at the ask and before the edit. Asked to put a download in a handler, the agent kept the amounts in minor units and said which two decisions the request cut against. On Codex 0.162.0 the choosing itself was run live through Unl's hook, and a whole Codex session with it has not been run. On Cursor the agent's own command took about 13 seconds to answer, which is longer than a hook may wait, so there Unl goes by the words of what you asked and the place of the file.

In the Cursor run the rule had been taken out of the rules file, so the hook was the only way the agent could learn it. The agent set out to run `git add -A`, Unl spoke first, and the agent told the person about the decision and its reason instead of running the command. That is one run, not a measurement.

## The format

Every decision is kept in the open [kept-decision format](../decision-format): the decision, its reason, what it applies to, who decided and when, and what it replaced. Unl passes the format's conformance check, both on the addresses it computes and on the records a fresh install writes (`npx unlimitless export`). The rules files it writes are that format in a form people can read.

## Commands

```text
npx unlimitless init                 set Unl up in this project
npx unlimitless status               what is kept here and what is waiting for you
npx unlimitless list                 the decisions kept for this project
npx unlimitless why <id>             one decision in full
npx unlimitless keep "<decision>" --why "<reason>"
npx unlimitless replace <id> "<decision>" --why "<reason>"
npx unlimitless retire <id> --why "<reason>"
npx unlimitless review               go through what is waiting for you
npx unlimitless sync                 take in decisions that arrived through git
npx unlimitless remove               take Unl out of this project (add --files to remove the decision files too)
npx unlimitless receipt              what Unl handed your agent in the latest session
npx unlimitless receipt --copy       the moment Unl spoke first, ready to paste into a post
npx unlimitless adr                  the project's architecture decision records, shown back as decisions
npx unlimitless telemetry            the opt-in ping: what it would send, and on, off, show, reset
npx unlimitless serve --prompt "..." show what Unl would hand over, and why
npx unlimitless judge on | off       have your agent's own model choose what bears, or go by the words of the ask
npx unlimitless export               every kept decision as a record in the open format
```

## When you want more

This is the whole mechanism, running on one machine. The hosted Unl is the same record in every AI you use, including the chat apps and your phone, kept in step across your machines and your team, with Agent Unl choosing what bears and nothing to set up. It is in the same package: `npx unlimitless login` signs this machine in and `npx unlimitless connect` adds it to a project. `npx unlimitless up` gives you the one command that moves a project up. Each decision that still stands comes across with its reason exactly as you kept it, and you keep it there with a yes. Nothing leaves your machine until you run that command.

## The hosted Unl

The same record in every AI you use, including the chat apps and your phone, kept in step across your machines and your team. It needs an account, and only when you choose it.

With the agent you already use, tell it:

```text
Read unlimitless.ai/start.md, set up Unl, and show me the decisions you find.
```

Or set it up yourself:

```bash
npx unlimitless login           # sign this machine in, once, in your browser
npx unlimitless connect         # Claude Code: the MCP server and the hook that serves your decisions on every turn
npx unlimitless connect --cursor
npx unlimitless connect --codex
unl                 # once signed in, the Unl terminal: what Unl handed your agent each turn, with the reasons
```

`connect` also takes `--dry-run` to show what it would change, and `--repair` to update its own entries in place. It never adds Unl a second time. Step-by-step for every other AI is at [unlimitless.ai/connect](https://unlimitless.ai/connect).

## Licence

Apache-2.0. See [LICENSE](LICENSE).
