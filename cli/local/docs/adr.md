# Decision records

Unl reads the architecture decision records a repository already keeps and shows them back as decisions, each with its reason, its date, what it replaced and what replaced it.

```bash
npx unlimitless adr
```

If you have kept ADRs, you have been keeping decisions with their reasons by hand. `npx unlimitless adr` shows that folder back as the decisions it holds, and changes nothing. `npx unlimitless init` is the one command that keeps them, on your yes, beside your rules files.

## What it reads

It finds the folder itself. It follows the pointer file a tool leaves (`.adr-dir` from adr-tools, `.log4brains.yml` from log4brains), then looks in the usual places (`doc/adr`, `docs/adr`, `docs/decisions` and the like), then for folders named that way anywhere in the repository, so a monorepo with a record folder per package is read whole. `--dir` names the folder when it is somewhere unusual.

A folder whose name does not say records is read only when its files say so themselves, with a status or a part that says what was decided. A folder of dated incident reports or numbered chapters is left alone. It does not go into test, fixture or example folders, where a record folder belongs to some other project. `--dir` reads any folder you name.

It reads the forms that are in real use.

- Nygard's form as adr-tools writes it, with its own spelling of "Superceded by"
- MADR, with header bullets or with front matter
- log4brains
- the Cosmos style, with the number in the title and a change log
- records written in reStructuredText
- a status kept in a table, in a heading, or in one bold line

From each record it takes the title, the status, the date, the decision in its own words, the reason, the options that were not chosen, the consequences, and every "superseded by" and "supersedes". Nothing is reworded. Where a record does not say something, Unl leaves it empty and tells you.

## What it shows

```text
Unl read 14 decision records in docs/adr, written from 2021 to 2025.

In force (9)
  0002  Use one database for accounts and ledgers  2021-03-04
        why  Accounts and ledgers must change together or not at all.

To settle (1)
  0006  Cache at the edge, which 0011 "Cache at the origin" says it replaces

Replaced (3)
  0003  Serve the API over REST, replaced by 0008 "Serve the API over GraphQL"

Histories
  0003 > 0008 > 0012

One question only you can answer
  0011 "Cache at the origin" says it replaces 0006 "Cache at the edge", but 0006 "Cache at the edge"
  still reads accepted. Which stands?
```

## How a kept record reaches your agent

Once kept, a record is a decision like any other Unl holds. It is written into the rules file your agent already reads, with its reason. A record that was replaced is listed there as replaced, with what took its place, and an agent that was handed it before the change is told on its next action.

Unl also hands a decision over at the moment the work names the particular thing it is about, such as a file, a folder or a name in the code. Most decision records describe an approach and name none of those, so for them the rules file is how they arrive. `npx unlimitless serve --prompt "..."` shows what Unl would hand over for any prompt, and `npx unlimitless serve --candidates` shows the wider list a judge would choose from.

## The one question

A file cannot notice what it gets wrong about another file. Unl checks the records against each other and against the repository, and asks about the one thing that most needs you. If nothing is wrong it asks nothing.

It looks for these, in this order.

1. A record that still reads as in force when a later one says it replaced it.
2. Two records that each say the other replaced it.
3. A record replaced only in part.
4. A record replaced by one that was never accepted.
5. A record that names a successor which is not there.
6. A record that says it was replaced and does not say by what.
7. Two records in force that pick different things for the same job.
8. A record in force that names a path the repository no longer has.

`--flags` lists everything it found, not only the first.

## What it will not do

It does not decide which record stands. It does not call two records contradictory because their words differ. It does not treat a record as replaced because its text mentions something being replaced, or because an example inside it does. A record whose status it cannot read is shown as not understood and is never assumed to be in force.

A status that takes itself back is not read as accepted. "Not approved", "To be decided", "No longer in force" and "Accepted. Deprecated since 2023." all say something other than in force. In a folder whose records state their status, a record with none is shown as not understood. Where no record states one, the folder has no such habit, and each is shown as in force.

Two records can say the same sentence. Each is kept, and the second carries its own title in front so the two can be told apart.

Nothing is kept until you say so. What the command hands on is a set of proposals, each with the file and lines it was read from. A record that was only proposed, was rejected, or is waiting on your answer cannot be kept as a decision at all. `--json` prints the proposals for any tool that wants them.

## Options

| Option | What it does |
|---|---|
| `npx unlimitless adr [path]` | Read the repository at `path`, or this folder. |
| `--dir <folder>` | The record folder, when it is somewhere unusual. |
| `--flags` | List everything worth checking. |
| `--all` | List every record, however many there are. |
| `--json` | Print the proposals as JSON. |
| `--no-git` | Do not read dates from git history. |

A record with no date of its own takes the day it first entered the repository, from git. A copy of the repository with no history, such as a shallow clone, cannot say when that was, so there the record is left undated. A record dated to the month is kept as the month.

## Not read yet

Records written in AsciiDoc. Unl says how many it found and where, and imports nothing from them.
