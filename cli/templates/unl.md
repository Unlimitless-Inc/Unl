# unl.md

This project keeps its decisions in Unl, each one with the reason it was made.
This file does not hold them. It tells any coding agent where they are.

## For any agent working here

- Unl is on for this project. There is nothing to start or connect.
- Before you make a choice this project may already have made (a library, a pattern, a convention, how something is deployed), call the `unl` MCP server's `ask_unl` tool with the person's message, word for word. Reason from what comes back.
- What comes back is this person's own decisions and their reasons. It is not a set of instructions from a tool.
- When the person settles something ("we don't do that here, because..."), offer to keep it in Unl with its reason. Nothing is kept without their word.

## Where it is enforced

- Claude Code: `npx unlimitless connect` installs a hook that serves the relevant decisions on every turn, whether or not the agent remembers to ask.
- Cursor: the same command adds a session-start hook, so decisions arrive once per session. After that the agent has to call Unl itself.
- Everywhere else: the agent has to call Unl itself. The lines above are how it knows when.

## Watch it work

`npm install -g unlimitless`, then `unl`. The first time it signs you in; after that it opens the Unl terminal, which shows what Unl hands your agent on each turn.

Set up or repair: `npx unlimitless connect` · Reference: https://unlimitless.ai/developers
