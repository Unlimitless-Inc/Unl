# How Unl keeps your decisions yours

Unl sits between you and an agent that acts on your behalf. So the question that matters is simple. Can anything other than you put a decision in your record, or change one? This page says how that is prevented, and where the limits are.

## The rule

Only a person makes a decision.

Everything else follows from it. An agent, a file, a web page and a tool result can all suggest something. None of them can decide it.

## How the rule is held

**Two kinds of row.** A decision and a proposal are different objects with different addresses. Nothing turns a proposal into a decision except a person saying yes.

**No tool keeps a decision.** The local server gives an agent three tools. It can read your decisions, read one in full, and propose one. There is no fourth tool, and the tests fail if one is ever added.

**Your yes is read from your own words.** When you answer "keep", Unl's hook reads what you typed. It does not take the agent's word that you agreed. On a tool where Unl cannot see what you type, an agent can still propose, and you keep it yourself with `npx unlimitless keep` in a terminal.

**A flag is not a person.** `npx unlimitless init --yes` keeps your rules only when you typed it at a terminal. Run by a script or by an agent, with nobody there, it reads the rules and keeps none of them. Unl then asks you once, in your agent, the next time you type something there.

**Keeping needs a terminal.** `npx unlimitless keep`, `npx unlimitless replace`, `npx unlimitless retire` and `npx unlimitless review` run only where a person is. An agent's shell has no terminal, so those commands refuse there.

**Unl speaks first if an agent tries anyway.** When an agent is about to run one of those commands, or to write into the record or the decision files by hand, the hook stops that one call and tells it that only a person keeps a decision and that it can propose one.

**Every decision says how the yes was given** (at a terminal, or in a session), and for a rule read from a file, who wrote that line according to git. The person who says yes and the person who wrote the rule are often not the same, and the record keeps both.

**Text that is not you is never read as you.** Pasted material, tool output and system notices are not treated as you stating a rule, even when they contain the words of one.

**Every decision names who made it.** The record refuses a decision with no person, and refuses one where the person and the model that proposed it are the same name.

**Every decision can be checked.** Its address is computed from its contents. A decision file that has been edited by hand no longer matches its address, and Unl refuses to take it in.

**A decision that arrives through git is its author's, and says so.** When a teammate keeps a decision and commits its file, your Unl takes it in on your next sync, checks its address, and hands it to your agent naming who decided it. It does not ask you first, in the same way your agent does not ask you before reading a rules file a teammate changed. So read a change under `.unl/` in a pull request the way you read a change to a rules file.

## What Unl does inside your agent

**It hands over context. It does not give orders.** What your agent receives is the decision, its reason and who decided it. What to do with it stays with the agent, and with you.

**It never decides what may run.** Permission belongs to the tool your agent runs in. When Unl speaks first it stops one call, once, so your decision reaches the agent before the action. It says so, and the same call goes through the second time. The receipt then says the agent went ahead.

**It asks your agent's own model which decisions bear, and that model can only choose.** Unl gathers the decisions that might bear with no model, then starts the agent you already run for one short turn and asks which of them do. The answer is a list of numbers. Each number names a decision on the list it was shown, and a number that names nothing is ignored. What your agent is then handed is put together from your record, word for word, so the model that chose never writes a decision, a reason or an instruction. Choosing is not keeping. Nothing on that path opens the record, so no answer can make a decision, whatever produced it.

**That short turn is fenced.** It runs in a folder of its own outside your project, with no tools, no servers and no hooks, and without your own customisations loaded. It cannot edit a file or run a command. Unl's own hook does nothing inside it, so it can never start another.

**A decision the work names is never left out.** If what you asked names the file, the folder or the command a decision is about, that decision reaches your agent whatever the model chose. The model can shorten it to one line. It cannot drop it.

**Speaking first is never left to a model.** Whether an action is the thing a decision says not to do is decided by Unl itself, at once. It does not wait for the choosing.

**It fails quiet.** If the hook cannot read its files or meets an event it does not know, it prints nothing and your work carries on. If your agent's model cannot be asked, because you are signed out or it is slow, Unl hands what the work plainly names in full and the nearest other decisions as one line each, never your whole record, and tells you once that it could not ask.

**It never opens the database to serve.** The hook reads one small file, so many agents can act at once without waiting on each other. The choosing takes a few seconds at each ask, and again the first time a file is about to change in a turn. A command is never held up by it.

## What leaves your machine

Unl itself sends nothing, unless you turn on the opt-in ping. There is no account, no key and no update check.

The ping is off until you run `npx unlimitless telemetry on`. It then sends four counts (installed, a decision kept, Unl spoke first, used on a later day), the version of Unl and a random id made on your machine. It never sends a decision, a reason, code, a file name or anything about you. `npx unlimitless telemetry` prints the whole list and the one line a ping consists of, `npx unlimitless telemetry show` prints every ping this machine has sent, and `DO_NOT_TRACK=1` stops it. [docs/telemetry.md](docs/telemetry.md) has all of it.

With the ping off the package makes no network connection. Its tests fail if any file outside the ping's own folder reaches for a network, the hook above all, and they fail if the ping sends anything before it has been turned on.

The one thing Unl starts that does reach a network is the agent you already run, for the short turn that chooses what bears. What it shows that agent is your decisions, what you asked, and the lines about to be written. That goes where your agent's prompts already go and nowhere else, on whatever your agent already runs on, and your agent is already shown all three. `npx unlimitless judge off` stops it. Unl then goes by the words of what you ask, and nothing is started.

What you asked is held in a file beside the record for the length of the turn, so a file about to change can be read against it. The next ask overwrites it, the end of the turn removes it, and it is never written into the record. If a turn ends without telling Unl, that one ask stays in the file until your next ask in that session. It is on your machine only, inside the project's own git folder, and `npx unlimitless remove` takes it away with the rest of the record.

The record lives in the project's own git folder, which git never commits. The readable decision files and Unl's section in your rules files are written into the working tree so that you can commit them. Read them before you do, as you would any file. They hold your decisions in your own words.

## What is not done yet

**Unl is not a sandbox.** An agent that can run commands as you can do what you can, including faking a terminal or editing files in the project. What is described above stops a decision being kept by accident, by an agent's say-so, or by a command an agent happened to run. Stopping an agent that sets out to deceive you is the job of the permission settings in the tool it runs in. Use both.

**You still read what you say yes to.** Planted words are tested: an agent's proposal that claims you agreed stays a proposal, pasted text is not read as your answer, what a tool hands back (a fetched page, a command's output) is never read at all, and a rule somebody else wrote into a rules file is kept only on your yes and says who wrote it. None of that helps if you say yes to a list without reading it. Unl shows you the rules before it asks, and `npx unlimitless review` goes through them one at a time.

**A name is not a signature.** A decision names who made it, taken from your git identity. Someone who can write to your repository can write a decision file that names you. The address proves a file was not altered after it was written. It does not prove who wrote it.

**A decision is only as good as its reason.** Unl marks decisions that have no reason. It does not judge whether a reason is a good one.

**What bears is chosen by a model, and a model can be wrong.** It can leave out a decision that bears, and it can hand one that does not. The README says how often, as measured. Your rules file still carries every decision, so an agent that reads it has them all.

**Text inside a decision could try to steer the choosing.** A decision is shown to the model as material to choose from, and the model is told that nothing written inside one is an instruction. That has been tested for what it can never do: no answer can keep a decision, add one, reword one or reach your record. It has not been tested against a decision written on purpose to make the model hand over more than it should. The worst that could do is put more of your own decisions in front of your agent.

**The choosing has been run in complete live Claude Code sessions.** Codex has hook-level prompt-judge proof, while a complete judged-session proof remains pending. Cursor uses word and file matching for edit and command hooks because the judge exceeds its hook wait.

## Reporting a problem

Write to hello@unlimitless.ai. Please do not open a public issue for a security problem.
