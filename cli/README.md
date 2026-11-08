# Unl, the open-source why agent for your coding agents.

If Unl keeps one decision for you, a star helps other builders find it.

Unl keeps what you decided and why on your machine, brings relevant decisions into your coding agent's work, and keeps track when you change your mind.

[Documentation](https://unlimitless.ai/docs) · [Discussions](https://github.com/Unlimitless-Inc/Unl/discussions)

For developers using coding agents in their projects. Carry settled choices and their reasons into later work and sessions, including changed decisions, with less repeated briefing.

## Try it in a project

Requires Node.js 20 or later and a coding agent. Run this from the project directory.

```bash
npx unlimitless init
```

Unl reads the agent rules you already wrote and shows them to you. You choose what to keep. No Unl account or API key is required. Your existing model provider's usage and charges still apply when the judge runs.

If the project has no rules yet, keep one from your own terminal. For example, where the project uses pnpm, run `npx unlimitless keep "Use pnpm for package commands" --why "The lockfile and CI use pnpm"`. Then ask your agent to add a dependency in that project. Read what Unl handed over with `npx unlimitless receipt`. Use a decision that is true of your project.

The receipt records delivery. It does not prove the agent used the decision.

## A decision has a reason and a history

A reason helps your agent apply a decision to situations you have not listed individually. Unl keeps the wording, reason, author, scope and history together. When you confirm a replacement, the old decision remains in the history and the new decision takes its place.

Unl gives your agent relevant decisions and reasons before supported actions; delivery does not guarantee that the agent follows them. Your agent does the reasoning. You decide what is kept and confirm what changes.

Bring decisions from CLAUDE.md, AGENTS.md, Cursor rules and ADRs. Keep your decisions and reasons current as your work changes.

## Use the tools you already use

| Tool | Support | Proof and limits |
|---|---|---|
| Claude Code | Prompt and pre-edit hooks | Judged hooks tested in complete sessions on macOS with Claude Code 2.1.319. |
| Codex | Prompt judge with `npx unlimitless init --codex` | Approve the hook when Codex first prompts in `/hooks`. Hook-level proof on Codex 0.162.0. A complete judged-session proof remains pending. |
| Cursor | Word and file matching for edit and command hooks | Tested with Cursor CLI 2026.10.18. The judge is slower than its hook wait. Its prompt hook did not fire in a headless run. |
| Tools that read AGENTS.md | Generated decisions section | Decisions reach the tool when it reads the file. No hook support is implied. |

Agent sessions have been run live on macOS. Linux, Windows and WSL have package install and `init` checks in CI, without a live agent.

Unl can stop a matching call once to bring a decision to your attention. The same call can run on a second attempt. Your coding tool still owns permissions. Unl is not a sandbox or a security boundary.

## Keep the record with your work

In a Git repository, the local database is stored in its git storage. Outside Git it uses `.unl/local`. Worktrees of the same clone share that record. Readable decisions are written to `.unl/decisions/`; review them before committing or sharing your repository. Unl updates only its marked sections in AGENTS.md and CLAUDE.md.

With telemetry off, the local package makes no network connection. The judge runs through your existing coding agent and may send decisions, your request and pending lines to that agent's provider. To use word matching instead, run `npx unlimitless judge off`.

Automatic sharing with the hosted connection is not available yet. Signing in does not transfer your local record or history.

Telemetry is opt-in. Read the [exact fields and implementation](https://github.com/Unlimitless-Inc/Unl/blob/main/cli/local/docs/telemetry.md). Decisions use the open [kept-decision format](https://github.com/Unlimitless-Inc/Unl/tree/main/decision-format).

### Remove Unl

Run `npx unlimitless remove` to remove the record and Unl's hooks in `.claude/settings.local.json`. Add `--files` to also remove Unl's sections in AGENTS.md and CLAUDE.md and the `.unl/` folder.

This leaves the shared hook runtime in `~/.unl/open/`, Codex's hooks if you ran `init --codex`, and any Unl server entry in Claude Code's or Cursor's MCP settings. Remove those separately to take everything out.

## Help make Unl better

Start with the [contributing guide](https://github.com/Unlimitless-Inc/Unl/blob/main/CONTRIBUTING.md). Useful contributions include reproductions of missed decisions, quieter matching, clearer first-run instructions and better host adapters.

Include the version, tool, operating system, expected result and actual result. Use a small invented project and decisions. Keep private decisions and credentials out of issues.

Discussions is for questions and ideas. Issues is for reproducible faults.

The repository contains the local product in `cli/local`, its command in `cli`, the open format in `decision-format`, the AI SDK in `packages/ai-sdk`, and hosted integration examples in `examples`. The hosted server is not in this repository.

## Security

Use the [private reporting route](https://github.com/Unlimitless-Inc/Unl/blob/main/SECURITY.md) for a suspected vulnerability. Unl supplies context to an agent; it is not a sandbox or a permission system. The [local threat model](https://github.com/Unlimitless-Inc/Unl/blob/main/cli/local/SECURITY.md) explains this boundary.

## License

The local Unl package is Apache-2.0. The format, SDK and examples retain MIT. See each component's licence before reusing it and the [repository licence map](https://github.com/Unlimitless-Inc/Unl/blob/main/CONTRIBUTING.md#component-licences).

[![smithery badge](https://smithery.ai/badge/unlimitless/Unl)](https://smithery.ai/servers/unlimitless/Unl)

## Optional hosting

Unl can also be reached through a hosted connection for supported AIs. It requires an account. The local installation stays free and works offline. Automatic sharing between these doors is not available yet; connecting does not transfer your local history. Read the [connection guide](https://unlimitless.ai/hosting/setup) before moving existing decisions.
