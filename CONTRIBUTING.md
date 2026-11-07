# Contributing

This repository holds the open-source Unl product for coding agents, including the local decision store, matching and judge adapters, hooks, command, decision format, SDK and examples. Contributions to local decision selection and delivery belong here. The hosted server is not included.

## What we take

- **Bug reports.** Use the bug form. Say what you ran, what you expected and what happened, with versions.
- **Fixes to docs and examples.** A broken link, a step that no longer works, a wrong version.
- **Small fixes to the code here,** with a test that fails before the fix and passes after it.

For anything larger, such as a new framework example or a change to the decision format, open an issue first so we can agree the shape before you spend time on it.

## Never put these in an issue or a pull request

- A key, token or password, including an expired one.
- The text of your own decisions, or anyone else's. Describe the shape of the problem with made-up content instead.

## Running the checks

```bash
cd packages/ai-sdk && npm install && npm test      # the AI SDK package, against synthetic responses
cd decision-format && node conformance.mjs         # the decision format's reference code
node cli/bin/unl.js --help                         # the command runs without signing in
```

None of these needs an account or a model call.

## Using AI to write your change

You are welcome to. Say so in the pull request, and read every line before you send it: a person reviews and merges each change, and is answerable for it.

## Licence

Contributions use the licence of the component they change.

### Component licences

| Component | Licence | Licence text |
|---|---|---|
| `cli/`, including `cli/local/` | Apache-2.0 | [cli/LICENSE](cli/LICENSE) |
| `packages/ai-sdk/` | MIT | [packages/ai-sdk/LICENSE](packages/ai-sdk/LICENSE) |
| `decision-format/`, `examples/`, plugins and remaining repository material | MIT | [LICENSE](LICENSE) |

The export validates package metadata against this map. It never changes the licence of an unknown package to make it fit.
