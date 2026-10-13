---
title: Add the ViteHub skill
navigation.group: AI resources
description: Install the ViteHub coding-agent skill in Claude Code, Cursor, VS Code, Windsurf, or Codex.
navigation.title: ViteHub skill
navigation.order: 261
icon: i-lucide-scroll-text
---

The ViteHub skill gives a coding agent one repeatable process for ViteHub work.
The agent orients in the project, loads only the references that match the task, checks the installed package contract, builds the file set, and proves each requested behavior.

`vitehub.dev` publishes the skill at [`/.well-known/skills/vitehub/SKILL.md`](https://vitehub.dev/.well-known/skills/vitehub/SKILL.md). The [skills CLI](https://github.com/vercel-labs/skills) reads the [skill index](https://vitehub.dev/.well-known/skills/index.json) and installs the skill from the site URL.

## Install for your agent

Run the command from the project root.
`--skill vitehub` selects the ViteHub skill, because the index also lists other skills. `--agent` selects the coding agent.

::tabs
  :::tabs-item{label="Claude Code" icon="i-simple-icons-claude"}
    ```bash [Terminal]
    npx skills add https://vitehub.dev --skill vitehub --agent claude-code
    ```

    The CLI writes the skill to `.agents/skills/vitehub/` and links it from `.claude/skills/vitehub/`.
  :::

  :::tabs-item{label="Cursor" icon="i-simple-icons-cursor"}
    ```bash [Terminal]
    npx skills add https://vitehub.dev --skill vitehub --agent cursor
    ```

    The CLI writes the skill to `.agents/skills/vitehub/`.
  :::

  :::tabs-item{label="VS Code" icon="i-simple-icons-githubcopilot"}
    ```bash [Terminal]
    npx skills add https://vitehub.dev --skill vitehub --agent github-copilot
    ```

    The CLI writes the skill to `.agents/skills/vitehub/` for GitHub Copilot.
  :::

  :::tabs-item{label="Windsurf" icon="i-simple-icons-windsurf"}
    ```bash [Terminal]
    npx skills add https://vitehub.dev --skill vitehub --agent windsurf
    ```

    The CLI writes the skill to `.agents/skills/vitehub/` and links it from `.windsurf/skills/vitehub/`.
  :::

  :::tabs-item{label="Codex" icon="i-simple-icons-openai"}
    ```bash [Terminal]
    npx skills add https://vitehub.dev --skill vitehub --agent codex
    ```

    The CLI writes the skill to `.agents/skills/vitehub/`.
  :::
::

To install for several agents at once, list them after `--agent`, for example `--agent claude-code cursor codex`.
Add `--global` to install the skill for every project of the current user instead of one project.
Run `npx skills list` to see the installed project skills.

## Ask for an outcome

The skill activates from normal ViteHub requests.
State the result you want and include any host or runtime constraint.

| Task | Example prompt |
| --- | --- |
| Server Primitive | `Add ViteHub KV to this route and prove that a value survives a restart.` |
| Agent | `Create a provider-backed review Agent with repository context and invoke it locally.` |
| Host boundary | `Build this ViteHub application for Cloudflare and inspect its Provider Output.` |

The skill selects one primary product lane, reads only the matching references and the smallest live docs pages, and checks the installed exports and types.
It reports the proof for each requested behavior.
When the documentation and the installed version differ, the installed contract controls the implementation and the agent reports the difference.

The bundled references teach composition, not a copy of the API reference. They cover project shapes, preview contracts, Server Primitives, framework composition, Agent Definitions and Drivers, Workspaces and Sources, Channels and Triggers, Capabilities, orchestration, Boxes and hosts, proof and recovery, and public project patterns.

## Add live docs lookups

The skill links to raw documentation pages, so the agent needs network access to read them.
To let the agent also search the documentation through tools, [connect the docs MCP server](/docs/getting-started/ai-resources/mcp-server).
When the coding tool cannot install skills, start from [`llms.txt`](https://vitehub.dev/llms.txt) and give the agent one [raw Markdown page](/docs/getting-started/ai-resources/markdown-pages).

## Keep instruction sources distinct

ViteHub uses several instruction sources for different actors.
Keep them separate, so that repository guidance does not leak into runtime Agent behavior.

| Source | Audience | Purpose |
| --- | --- | --- |
| Public ViteHub skill | Coding agents that build a ViteHub application | Routes project patterns through live docs, installed contracts, explicit authority, and runtime proof. |
| Repository `AGENTS.md` | Coding agents that contribute to a repository | Defines local development rules and project boundaries. |
| [Agent Driver Instructions](/docs/agents/instructions) | Agents that run inside an application | Defines model-facing runtime behavior. |
| Agent-local `skills/` | Provider-backed Agent Invocations | Installs Skills that a folder Agent Definition owns. |
| [`skills()` Capability](/docs/agents/capabilities/skills) | ViteHub Agent Invocations | Makes Workspace-backed or external Source Skills available to the Agent. |

Agent-local Skills require a folder Definition. Put them beside `server/agents/<name>/agent.ts` under `server/agents/<name>/skills/<skill>/SKILL.md`. ViteHub materializes them in the Agent Workspace at `.agents/skills/<skill>/SKILL.md`. A flat Definition such as `server/agents/review.ts` cannot own a sibling Skill tree. Move it to `server/agents/review/agent.ts` when it needs colocated Skills.
