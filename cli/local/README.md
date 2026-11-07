# Unl

The why agent for your AI stack.

Unl keeps what you decided and why, on your own machine, and hands it to your coding agent when it bears.

Never update your CLAUDE.md again.

```bash
npx unlimitless init
```

Run it in a project. There is no account, no key and nothing to sign in to, at install or in use.

It needs Node.js 20 or later, which is what puts `npx` on your machine. Every command below runs through `npx unlimitless`, so nothing has to be installed first.

Every decision is kept in the open [kept-decision format](../../decision-format), which any tool can read and check.

## What it does

- It reads the rules you already wrote for your agents and, on your yes, keeps each one as a decision with its reason.
- It hands your agent the decisions that bear on what you asked, and nothing when nothing bears.
- It speaks first when your agent is about to do something you decided against.
- It notices when you state a new rule and asks once whether to keep it. When the new one changes an old one, the old one is marked replaced.
- It writes AGENTS.md and CLAUDE.md from that record, so every tool that reads them has your current decisions.

## Try it in 60 seconds

In a new folder:

```bash
mkdir unl-try && cd unl-try && git init -q
echo 'Use pnpm, never npm. We switched because npm kept breaking the lockfile.' > CLAUDE.md
npx unlimitless init
```

Say yes to the one decision it finds. Then open Claude Code in the folder and type:

```text
From now on we use bun instead of pnpm, because pnpm's install was too slow on CI.
```

Unl says this reads as a change to the pnpm decision, and asks you to reply "keep" with one line on why. Reply `keep, pnpm was too slow on CI`. Unl says it kept the bun decision and that it replaces the pnpm one. Back in the terminal:

```bash
npx unlimitless status
```

It says 1 decision is kept and 1 was replaced. AGENTS.md and CLAUDE.md now carry the bun decision with its reason, and the pnpm one under Replaced. In your next session, ask the agent to install the dependencies, and it is handed the bun decision.

Without Claude Code, the same change works at the terminal: `npx unlimitless list` gives the pnpm decision's id, and `npx unlimitless replace <id> "Use bun, not pnpm." --why "pnpm's install was too slow on CI."` replaces it.

## How it works

- **Hooks.** `init` adds hooks to your agent: Claude Code's (in `.claude/settings.local.json`), which Cursor also runs, and Codex's with `--codex`. They run at each ask and before an edit or a command.
- **The record.** Your decisions live in `.git/unl/` inside the project, never in git itself. Every worktree of the clone shares it. Readable copies go to `.unl/decisions/`, and to a marked section of AGENTS.md and CLAUDE.md, for you to commit.
- **Choosing what bears.** Unl first gathers the decisions that might bear, with no model. On Claude Code and Codex it then asks your agent's own command line which of them do, for one short turn: `claude -p`, on Sonnet unless you set another model, or `codex exec` with your configured model, at the ask only. The answer is only which ones. What your agent is handed is your decision and your reason exactly as you kept them.
- **Cursor's simpler matching.** Cursor is not asked. There, Unl goes by the words of what you asked and the file being changed.
- **Speaking first.** Whether a command or an edit crosses a decision is decided by Unl itself, at once, with no model. It stops that one call, once, so the decision reaches you before the action.

## What it does not do yet

- It hands over more than bears. On the reading below, about 3 in 10 of what it handed bore on the work, and how often it stays quiet on work nothing bears on has not been read.
- Cursor gets no model choosing what bears, and Cursor's prompt hook did not fire in a headless run, so that part is unproven there.
- On Codex, the choosing was run live through the hook, but a whole Codex session with Unl has not been run.
- Agent sessions have been run live on macOS. On Linux, Windows and WSL, the package's install and `init` are checked in CI, without a live agent.
- It is not a sandbox and never grants or refuses permission. Use it beside your tool's own permission settings.
- `npx unlimitless remove` leaves a few things in place. Uninstall below says which.

## Privacy and telemetry

- No account, no key and no sign-in, at install or in use.
- The record stays in `.git/unl/` on your machine. It goes to the hosted Unl only if you run `npx unlimitless connect`, or the command `npx unlimitless up` gives you.
- Choosing what bears goes through your agent's own command line and provider, and counts against your usage there. `npx unlimitless judge off` stops it, and Unl then goes by words.
- Telemetry is off until you run `npx unlimitless telemetry on`. `DO_NOT_TRACK=1` stops it, and it never sends from CI. When on, it sends four events, each with the version, a random machine id and, where it applies, a count. It never sends decision text, prompts, code or project names. Telemetry below lists the events.

## Uninstall

```bash
npx unlimitless remove           # the record, and Unl's hooks in .claude/settings.local.json
npx unlimitless remove --files   # also Unl's section in AGENTS.md and CLAUDE.md, and the .unl/ folder
```

`remove` leaves the shared hook runtime in `~/.unl/open/`, Codex's hooks if you ran `init --codex`, and any Unl server entry in Claude Code's or Cursor's MCP settings. Delete those by hand to take everything out.

## Questions

**Does anything leave my machine?** Your record does not, unless you move it to the hosted Unl yourself. Choosing what bears goes through your agent's own provider, as above. Telemetry is off unless you turn it on.

**Which model does it use, and what does it cost?** The free Unl costs nothing. On Claude Code it runs `claude -p` on Sonnet by default, and on Codex `codex exec` with your configured model, so those calls count against your existing usage. Cursor makes no model call. `init` makes none either.

**Which agents does it work with?** Claude Code, with Cursor running the same hooks, and Codex with `init --codex`. Any other tool that reads AGENTS.md or CLAUDE.md gets your decisions through the file, without the hooks.

**Does it slow my agent down?** The model call is capped at 12 seconds on Claude Code and 15 on Codex (`UNL_JUDGE_TIMEOUT_MS` changes it). If it runs out, Unl hands what the work plainly names in full and a capped set of others as one line each, never your whole record.

**Does it actually help?** On a development reading, not a release test, of 200 pieces of work in 20 public repositories, 302 of the 358 decisions that bore reached the agent. In 56 tasks across 9 repositories with a stale rules file, run once each, the work needed 5 corrections with Unl, 7 with a well-kept file, 8 with the stale file and 10 with no file. That shows fewer than no file. It does not show better than a well-kept file.

**Why is `unl` not found?** `npx` does not put a `unl` command on your PATH. Every command works as `npx unlimitless <command>`, and `npm install -g unlimitless` gives you `unl` as well.

**Can my team share it?** Commit `.unl/decisions/` and the section in your rules files. A teammate who pulls and runs `npx unlimitless init` gets the same decisions, and `npx unlimitless sync` takes in ones that arrive later.

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

The free Unl sends nothing of its own, unless you turn on the ping described under Telemetry below. It is off until you do. With it off, the free Unl makes no network connection of its own, and its tests fail if it ever tries to. Within the free Unl, the one folder that can send anything is the ping's own, and its tests fail if it sends before you have turned it on. The same package also holds the hosted Unl's commands (`login`, `connect`, `up` and the Unl terminal), and those talk to the hosted service when you run them.

On Claude Code and Codex, to choose which decisions bear, Unl asks your agent's own command line for one short turn: `claude -p`, on Sonnet unless you set another model, or `codex exec` with your configured model, at the ask only. What it shows that model is your decisions, what you asked and the lines about to be written. That call goes to your agent's provider and counts against your usage there. Cursor is not asked. `npx unlimitless judge off` stops it, and Unl then goes by the words of what you ask.

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

If the records disagree with each other, Unl asks the one question that most needs you and leaves the rest for later. `npx unlimitless adr` shows the records and that question at any time, and changes nothing. [docs/adr.md](docs/adr.md) has the forms it reads and everything it checks.

## Showing someone

When Unl speaks first, the receipt for that moment can be pasted into a post as it is.

```bash
npx unlimitless receipt --copy
```

It carries the decision, its reason, the day it was settled, what your agent was about to do and what it went to do next. It never carries a command line your agent typed: for a command it gives your decision's own words for it, or the name of the program, and for a file its name. Your own words are read once more for keys, addresses and home folders, and Unl says what it took out. [docs/receipt.md](docs/receipt.md) shows one.

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

Setting `DO_NOT_TRACK=1` stops it, and it never sends from CI. [docs/telemetry.md](docs/telemetry.md) is the whole of it, including the one line a ping consists of.

## Only you make a decision

An agent can propose a decision. It cannot keep one. There is no tool that lets it, and that is the design.

- What Unl reads from a file is a proposal until you say yes.
- What an agent proposes is a proposal until you say yes.
- Your yes is read from what you typed, by Unl itself. An agent saying "they agreed" is not evidence and nothing accepts it.
- A flag is not a person. Run with nobody at a terminal, `npx unlimitless init --yes` keeps nothing, and Unl asks you once in your agent.
- The commands that keep, replace and retire run only at a terminal, and Unl speaks first if an agent tries one.
- Every kept decision names the person who made it and when, and carries an address computed from its contents. Anyone holding the file can recompute the address and know it has not been altered.

See [SECURITY.md](SECURITY.md) for the whole of it, including what has not been tested yet.

## Four things that have to be true, and where each stands

**1. What you decided never gets mixed up with what something else suggested.** Built as above. A web page, an agent's suggestion and your settled decision are different kinds of row and only your yes turns one into another. It is tested against planted words: a proposal claiming you agreed, pasted text, a flag with nobody there, an agent's own shell. It is not a sandbox, and [SECURITY.md](SECURITY.md) says where that line is.

**2. What bears arrives and the rest stays out.** Unl gathers the decisions that might bear with no model, and then, on Claude Code and Codex, asks your agent's own command line which of them do. That model answers with which ones and never with words of its own, so what your agent is handed is your decision and your reason exactly as you kept them. What bears is handed in full. What might bear is handed as one line. A decision the work names outright is never left out, and whether an action crosses a decision is decided by Unl itself, at once, with no model. A rule that applies to every change, such as how commits are written, is left to the rules file your agent already reads on every turn. A development reading on 20 public repositories Unl had never seen (not a release test) took the 200 pieces of real work in them that a kept decision bore on. Of the 358 decisions that bore, 302 reached the agent when the ask was long and 300 when it was one line, which is a little over 8 in 10. The words of the ask alone had reached about 2 in 10. About 3 in 10 of what it handed on that work bore. How often it stays quiet on work nothing bears on has not been read for this build. So it finds most of what bears and still hands over more than it should, and it does not claim otherwise. If your agent's model cannot be asked in time, Unl hands what the work plainly names in full and the nearest others as one line each, never your whole record, and tells you once. On Cursor, and on Codex before an action, no model is asked at all, and Unl goes by the words. `npx unlimitless serve --prompt "..."` shows what Unl would hand over for any prompt, file or command, and why, and `npx unlimitless serve --candidates` shows the wider list that is chosen from.

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

Every decision is kept in the open [kept-decision format](../../decision-format): the decision, its reason, what it applies to, who decided and when, and what it replaced. Unl passes the format's conformance check, both on the addresses it computes and on the records a fresh install writes (`npx unlimitless export`). The rules files it writes are that format in a form people can read.

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
npx unlimitless remove               take Unl out of this project (add --files to remove its section in your rules files and .unl/ too)
npx unlimitless receipt              what Unl handed your agent in the latest session
npx unlimitless receipt --copy       the moment Unl spoke first, ready to paste into a post
npx unlimitless adr                  the project's architecture decision records, shown back as decisions
npx unlimitless telemetry            the opt-in ping: what it would send, and on, off, show, reset
npx unlimitless serve --prompt "..." show what Unl would hand over, and why
npx unlimitless judge on | off       on Claude Code and Codex, have your agent's model choose what bears, or go by the words of the ask
npx unlimitless export               every kept decision as a record in the open format
```

## When you want more

This is the whole mechanism, running on one machine. The hosted Unl is the same record in every AI you use, including the chat apps and your phone, kept in step across your machines and your team, with Agent Unl choosing what bears and nothing to set up. It is in the same package: `npx unlimitless login` signs this machine in and `npx unlimitless connect` adds it to a project. `npx unlimitless up` gives you the one command that moves a project up. Each decision that still stands comes across with its reason exactly as you kept it, and you keep it there with a yes. Your record leaves your machine only when you run that command.

## Licence

Apache-2.0, as part of the `unlimitless` package. See [LICENSE](../LICENSE).
