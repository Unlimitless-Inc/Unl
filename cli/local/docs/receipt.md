# The receipt

When Unl speaks first, the moment can be pasted into a post as it is.

```bash
npx unlimitless receipt --share   # show it
npx unlimitless receipt --copy    # show it and put it on the clipboard
```

```text
Unl spoke first.

My agent was about to
  edit handler.ts

Unl handed it a decision I settled on 12 Aug 2026
  Exports run on a background queue, not inside the request.
  Why: Larger files exceed the request timeout, so the export has to outlive the request.

What it went to do next
  edit queue.ts

Unl: github.com/Unlimitless-Inc/unl
```

## What is in it

The decision and its reason, in the words they were kept in. The day it was settled, where that is known. One line on what your agent was about to do, and one line on what it went to do next.

It says "a decision I settled" only when you are the one who made it. A decision a teammate made, which reached you through git, is "a decision settled on" that day.

## What is not in it

No command line your agent typed. A command can carry a password in more ways than any filter knows, so Unl does not filter one. It does not read it. Where Unl spoke first about a command, the receipt gives your decision's own words for it, the ones you wrote, such as `git add -A`. For any other command it gives the name of the program and nothing after it, such as `psql` or `npm run`.

No folders. A file is its name, such as `handler.ts`, and nothing of where it sits.

No code.

Your own words are read once more for what you would not mean to post. A key, a password or a token by its shape. The sign-in inside a link. An email address. A machine's address in numbers. A home folder, which has your name in it. Whatever Unl takes out it names under the receipt, so nothing goes missing without a word.

Unl cannot know that a word in your decision is a customer's name, or that `db.internal` is a machine and not a file. That is why it shows you the receipt before it copies it.

## What it says and does not say

A receipt says Unl gave your agent a decision, and what the agent went to do before and after. It does not say the agent used the decision, because a receipt can prove what was handed over and the order things happened in, and nothing more. What came next is what the agent went to do. Unl sees a call as it is about to be made, so the receipt does not say it was carried out. If the agent went ahead anyway, the receipt says so.

## Forms

| Command | What you get |
|---|---|
| `npx unlimitless receipt --share` | The latest moment Unl spoke first, as plain text. |
| `npx unlimitless receipt --short` | Short enough for one post of 280 characters. |
| `npx unlimitless receipt --markdown` | As markdown, with the decision quoted. |
| `--no-footer` | With any of those, without the last line. |
| `--copy` | With any of those, puts it on the clipboard. |

`npx unlimitless receipt` with none of these is a different thing. It is the account of your latest session for you, in your own terminal, and it shows what your agent ran as it ran it. It is not made to be posted.
