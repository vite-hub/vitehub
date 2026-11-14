---
title: Add the ViteHub skill
navigation.group: Coding agents
description: Install the ViteHub coding-agent skill in Claude Code, Cursor, VS Code, Windsurf, or Codex.
navigation.title: ViteHub skill
navigation.order: 261
icon: i-lucide-scroll-text
---

The ViteHub skill is a small set of Markdown instructions that gives a coding agent one repeatable process. The agent reads the project, loads only the references the task needs, checks the installed package contract, writes the files, and proves each requested behavior.

The skill lives at [`/.well-known/skills/vitehub/SKILL.md`](https://vitehub.dev/.well-known/skills/vitehub/SKILL.md). The [skills CLI](https://github.com/vercel-labs/skills) reads the [skill index](https://vitehub.dev/.well-known/skills/index.json) and installs it from the site URL.

## Install for your agent

Run the command from the project root. The index lists other skills too, so `--skill vitehub` picks this one. `--agent` picks the coding agent.

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

- To install for several agents, list them after `--agent`, for example `--agent claude-code cursor codex`.
- Add `--global` to install for all your projects instead of one.
- Run `npx skills list` to see installed project skills.

### Install from your app

An app with the [Console](/docs/development/console) endpoint also serves the skill at `/_vitehub/.well-known/skills/`. That copy comes from the installed `vite-hub` package, so it matches the app's version. Pass the `/_vitehub` URL of the dev server or the deployed app:

```bash [Terminal]
npx skills add http://localhost:3000/_vitehub --skill vitehub --agent claude-code
```

The skill files are static and need no signature, even in production. They hold only the public skill, no app data.

To serve your own app's skills for `npx skills add` and MCP clients, use [`vite-hub/skills`](/docs/development/skills).

## Ask for an outcome

Normal ViteHub requests start the skill. State the result you want and any host or runtime constraint.

| Task | Example prompt |
| --- | --- |
| Server Primitive | `Add ViteHub KV to this route and prove that a value survives a restart.` |
| Agent | `Create a provider-backed review Agent with repository context and invoke it locally.` |
| Host boundary | `Build this ViteHub application for Cloudflare and inspect its Provider Output.` |

The skill picks one main product area, reads only matching references and the smallest live docs pages, and checks installed exports and types. It reports proof for each requested behavior. When the docs and the installed version differ, the installed package wins and the agent reports the difference.

The bundled references teach how parts fit together, not the API reference. They cover project shapes, preview contracts, Server Primitives, framework composition, Agent Definitions and Drivers, Workspaces and Sources, Channels and Triggers, Capabilities, orchestration, Sandboxes and hosts, proof and recovery, and public project patterns.

## Add live docs lookups

The skill links to raw docs pages, so the agent needs network access. To let it search the docs through tools, [connect the docs MCP server](/docs/getting-started/ai-resources/mcp-server). If your tool cannot install skills, start from [`llms.txt`](https://vitehub.dev/llms.txt) and give the agent one [raw Markdown page](/docs/getting-started/ai-resources/markdown-pages).

## Keep instruction sources distinct

Each instruction source serves a different reader. Keep them separate so repository rules do not leak into runtime Agent behavior.

| Source | Audience | Purpose |
| --- | --- | --- |
| Public ViteHub skill | Coding agents that build a ViteHub app | Guides work through live docs, installed contracts, explicit authority, and runtime proof. |
| Repository `AGENTS.md` | Coding agents that contribute to a repository | Sets local development rules and project boundaries. |
| [Agent Driver Instructions](/docs/agents/instructions) | Agents that run inside an app | Sets runtime behavior for the model. |
| Agent-local `skills/` | Provider-backed Agent runs | Installs Skills that a folder Agent Definition owns. |
| [`skills()` Capability](/docs/agents/capabilities/skills) | ViteHub Agent runs | Gives the Agent Skills from its Workspace or an external Source. |

Agent-local Skills need a folder Definition. Put them beside `server/agents/<name>/agent.ts` at `server/agents/<name>/skills/<skill>/SKILL.md`. A model Driver reads them from the Agent Workspace at `.agents/skills/<skill>/SKILL.md`. A Provider Driver gets them from a private folder outside its working directory, or from the Sandbox Home. ViteHub does not write them into the Workspace or the checkout for it. See [Give the provider its Skills](/docs/agents/agent-drivers#give-the-provider-its-skills). A flat Definition such as `server/agents/review.ts` cannot own Skills. Move it to `server/agents/review/agent.ts` first.
