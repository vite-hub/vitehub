---
title: ViteHub coding-agent skill
description: Install the public ViteHub skill for Cursor, Claude Code, Codex, and other coding agents.
navigation.order: 62
icon: i-lucide-scroll-text
---

The public ViteHub skill helps coding agents build applications with current documentation and the application's installed package contract.
It covers both Server Primitives and Agents without loading the complete documentation set into every task.

## Install the skill

Run the skills CLI from your project:

```bash [Terminal]
npx skills add https://vitehub.dev
```

The CLI discovers the published `vitehub` skill and installs it for the supported coding agents you select.
Run `npx skills list` to inspect installed project skills.

## Ask for an outcome

The skill activates from normal ViteHub requests.
State the result you want and include any host or runtime constraint.

| Task | Example prompt |
| --- | --- |
| Server primitive | `Add ViteHub KV to this route and prove that a value survives a restart.` |
| Agent | `Create a harness-backed review Agent with repository context and invoke it locally.` |
| Host boundary | `Build this ViteHub application for Cloudflare and inspect its Provider Output.` |

The skill selects one product lane, reads the smallest live docs page, checks installed exports and types, and reports the proof.
When documentation and an installed version differ, the installed contract controls the implementation and the agent reports the mismatch.

## Keep the instruction surfaces distinct

ViteHub uses several instruction surfaces for different actors.
Keeping them separate prevents repository guidance from leaking into runtime Agent behavior.

| Surface | Audience | Purpose |
| --- | --- | --- |
| Public ViteHub skill | Coding agents building a ViteHub application | Routes implementation through live docs, installed contracts, and proof. |
| Repository `AGENTS.md` | Coding agents contributing to a repository | Defines local development rules and project boundaries. |
| [Agent Driver Instructions](/docs/agents/instructions) | Agents that run inside an application | Defines model-facing runtime behavior. |
| Agent-local `skills/` | Harness-backed Agent Invocations | Automatically installs Skills owned by a folder Agent Definition. |
| [`skills()` Capability](/docs/capabilities/skills) | ViteHub Agent Invocations | Makes Workspace-backed or external Source Skills available to the Agent. |

Agent-local Skills require a folder Definition. Place them beside `server/agents/<name>/agent.ts` under `server/agents/<name>/skills/<skill>/SKILL.md`. A flat Definition such as `server/agents/review.ts` cannot own a sibling Skill tree; move it to `server/agents/review/agent.ts` when it needs colocated Skills.

## Use the docs fallback

When a coding environment cannot install skills, start from [`llms.txt`](https://vitehub.dev/llms.txt) and load one [raw Markdown page](/docs/ai-resources/markdown-pages).
Keep the page URL with the supplied context so the agent can report which contract it followed.
