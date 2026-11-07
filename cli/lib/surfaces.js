"use strict";
/*
 * THE HONEST SURFACE TABLE, as the installer prints it.
 *
 * "Enforced" is claimed ONLY where a hook delivers the decisions without the model choosing to
 * ask. Everywhere else the reach depends on the model calling Unl, and says so.
 */
const SURFACE_REACH = [
  {
    surface: "Claude Code",
    reach: "Enforced on every turn. A hook sends each message to Unl and hands the agent what bears on it before it answers.",
    recommend: "npx unlimitless connect",
  },
  {
    surface: "Cursor",
    reach: "Enforced once per session in the Cursor CLI, by a session-start hook (not yet verified in the Cursor app). After that the agent must call Unl itself.",
    recommend: "npx unlimitless connect --cursor",
  },
  {
    surface: "ChatGPT, Claude and other chat apps",
    reach: "Depends on the model. There is no hook, so the model calls Unl when it judges a turn needs it.",
    recommend: "Add Unl in the app's settings: unlimitless.ai/connect",
  },
  {
    surface: "Other coding agents",
    reach: "Depends on the model. The agent calls Unl because unl.md or its rules file tells it to.",
    recommend: "Add the MCP server, then point your rules file at unl.md",
  },
];

function surfaceTableText() {
  const lines = ["Where Unl reaches your agent:"];
  for (const r of SURFACE_REACH) lines.push(`  ${r.surface}\n    ${r.reach}\n    Setup: ${r.recommend}`);
  return lines.join("\n");
}

module.exports = { SURFACE_REACH, surfaceTableText };
