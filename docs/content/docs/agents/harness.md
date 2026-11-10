---
title: Agent harness
description: An agent harness runs an AI model as an agent, with tools, files, approvals, and sessions. ViteHub is an open source agent harness for TypeScript.
seo.title: What is an agent harness? A TypeScript harness
navigation.title: Agent harness
navigation.order: 3
navigation.group: Start
icon: i-lucide-layers
navigation.kind: Concepts
---

An agent harness is the software that runs an AI model as an agent. The model chooses the next step. The harness sends the context, runs the tools that the model asks for, asks a person for approval when needed, and keeps the session between turns.

ViteHub is an open source agent harness for TypeScript, under the Apache-2.0 license on [GitHub](https://github.com/vite-hub/vitehub). You define an Agent in one file on your server. Its Driver selects who runs the loop: ViteHub with a model, or the Codex or Claude Code harness. ViteHub adds tools, files, a Sandbox, approvals, entry points, and a record of each run.

::agent-only
Use this page to find the ViteHub API for each part of an agent harness. Read the linked page before you change that part.

Select a built-in Driver before you write your own agent loop. Attach only the Capabilities that the task needs. A Workspace or a Sandbox does not grant tools by itself.

Prove the result with `vitehub agent info` and one real Invocation on the target host. Provider Drivers need a Node.js host.
::

## What is an agent harness

A model only reads and writes text. The harness lets it open files, run commands, and remember turns, within limits. A harness usually owns these parts:

- **The loop** sends the prompt, instructions, and history to the model, runs each tool call, and stops when the model finishes or hits a step limit.
- **Tools** are actions that the model can request, such as reading a file or calling an API.
- **Context** is the instructions, files, and earlier messages that the model knows.
- **Permissions** decide which tool calls run, wait for a person, or fail.
- **The execution environment** decides where commands run and which files and credentials they reach.
- **Records** show what the agent did, so a person can check results and debug failures.

A good harness makes these parts explicit instead of hiding them in a prompt, so you can say what the agent was allowed to do.

## Agent harness vs agent framework

The LangChain docs [separate frameworks, runtimes, and harnesses](https://docs.langchain.com/oss/python/concepts/products). A framework gives you building blocks. A runtime runs agents in production. A harness is an "opinionated, batteries-included" framework with built-in tools for long-running agents, such as their Deep Agents. With a framework, you write the loop. With a harness, you configure a working loop.

Codex and Claude Code are harnesses too. OpenAI calls the open source runtime behind Codex the [Codex harness](https://developers.openai.com/blog/codex-as-a-platform). It keeps conversation state, runs tools, applies sandbox and approval policies, and carries work across turns. The [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) gives you the tools, loop, and context management of Claude Code as a library.

ViteHub runs these harnesses instead of copying them, because a copy would fall behind each release. An Agent selects Codex or Claude Code as its Driver, or uses the ViteHub model loop for smaller tasks.

## Open source agent harness for TypeScript

This Agent answers questions from the Markdown docs of a project in a web chat. ViteHub runs the model loop:

```ts [server/agents/docs/agent.ts]
import { defineAgent } from 'vite-hub/agent'
import { workspaceShell } from 'vite-hub/agent/capabilities'
import { webChat } from 'vite-hub/agent/channels'
import { glob } from 'vite-hub/workspace'

export default defineAgent({
  // The loop: ViteHub sends the prompt to this model and runs its tool calls.
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'Answer from the docs Workspace. Say when the answer is absent.',
  },
  // The tools: read-only file tools, and nothing else.
  capabilities: [workspaceShell({ mode: 'read' })],
  // The files: Markdown from this project.
  workspace: {
    sourceRootDir: process.cwd(),
    sources: {
      docs: glob({ cwd: '.', include: ['docs/content/**/*.md'] }),
    },
  },
  // The entry point: a generated chat route.
  channels: { portal: webChat() },
})
```

Each property is one part of the harness. ViteHub names the Agent `docs` after its folder in `server/agents`.

To run the same Agent in the Codex harness, change only the Driver:

```ts [server/agents/docs/agent.ts] fragment
driver: codexDriver({
  model: 'gpt-5.5',
  instructions: 'Answer from the docs Workspace. Say when the answer is absent.',
  permissions: 'ask',
}),
```

Now Codex runs the loop, its own file and shell tools, and the session. It works in a temporary directory with the Workspace files, so `workspaceShell()` adds no second set of file tools. `permissions: 'ask'` is the default, so provider actions ask for approval. Codex needs the `@openai/codex` package, credentials, and a Node.js host, as [Use a provider-backed Driver](/docs/agents/agent-drivers#use-a-provider-backed-driver) explains.

## How ViteHub works as an agent harness

### Agent Definition

An [Agent Definition](/docs/agents/agent-definitions) is one file in `server/agents` with the harness configuration for one Agent. Both `server/agents/docs.ts` and `server/agents/docs/agent.ts` create an Agent named `docs`. In the folder form, put longer [instructions](/docs/agents/instructions) in `instructions.md` and [Skills](/docs/agents/capabilities/skills) in a `skills/` folder beside `agent.ts`.

### Drivers

An [Agent Driver](/docs/agents/agent-drivers) decides who runs the loop for one Invocation (one run of the Agent).

| Driver | Who runs the loop | Use it for |
| --- | --- | --- |
| `{ model }` | ViteHub, with an AI SDK model | Answers, classification, extraction, structured output, and bounded tool use. |
| `codexDriver()` | The Codex harness | Code changes, shell commands, and coding sessions over many turns. |
| `claudeCodeDriver()` | Claude Code, through the Claude Agent SDK | Code changes, shell commands, and coding sessions over many turns. |
| `{ run }` | Your function | Work that does not need a model loop. |
| `{ ask }` | TypeSafe Jev | A few typed answers, such as a label or a score. |

Use Codex or Claude Code for work on a repository, because they already handle file edits, shell commands, approvals, and context. Use a model Driver for small tasks where ViteHub should run every tool call. The model loop stops after 20 steps by default. An [AI gateway](/docs/agents/ai-gateways) sends Codex and Claude Code model requests through your own proxy.

### Capabilities

[Capabilities](/docs/agents/capabilities) are the tools of the harness. A Capability adds named tools, triggers, input checks, or output data to an Invocation, not access to the full server. The [official Capabilities](/docs/agents/capabilities/official) include Workspace files, Database, KV, Blob, web search, Fetch, OpenAPI, MCP servers, Memory, and Budget.

Codex and Claude Code keep their own file and shell tools and get Capability tools through a private loopback MCP server.

### Workspace

A [Workspace](/docs/agents/workspace-context) is the file tree that the Agent can reach. It can mount Sources: sets of files, such as the project Markdown or a GitHub repository. A Workspace alone gives a model Driver no file tools. Add `workspaceShell()` for that.

A provider Driver runs in a temporary directory with the Workspace files. In write mode, a successful run commits its changes through the Workspace rules. Failed and cancelled runs do not write back.

### Sandbox

A provider Driver runs on the ViteHub host by default. Set `sandbox` on the Agent to start Codex or Claude Code in a [Sandbox](/docs/agents/sandboxes). It gives each Invocation a private Home, declared credentials, boot checks, and optionally a Git checkout at an exact commit.

The `trusted-host` runtime runs the Sandbox on the same machine. The `crabbox` runtime runs it on a Linux host over SSH. Neither isolates the filesystem or the network. Read [AI sandbox providers compared](/docs/guides/sandbox-providers) before you run code that you do not trust.

To run allowlisted commands in an isolated Sandbox from any Driver, attach the [`sandbox()` Capability](/docs/sandbox/agent-capability).

### Runtime policy and approvals

Two settings decide what runs without a person:

- `driver.permissions` controls Codex and Claude Code actions: `'ask'` (default), `'allow-edits'`, `'allow-edits-unattended'`, or `'allow-all'`.
- A tool `policy` controls each Capability tool: `'allow'` (default), `'deny'`, or `'require-approval'`.

The built-in HTTP chat route stores pending approvals and accepts each response once. A custom entry point must check the approver itself. [Runtime policy, approvals, and traces](/docs/agents/runtime-policy) explains who owns each approval. Set `budget` to limit tokens and cost per Invocation, as [Budget](/docs/agents/capabilities/budget) shows.

### Triggers and Channels

Server code can call `runAgent()` directly. A [Trigger](/docs/agents/triggers) turns a product event, such as a chat message, into Invocation input. A [Channel](/docs/agents/channels) connects an outside service and sends the reply back there. Built-in Channels include web chat, HTTP, Slack, Discord, Teams, Telegram, GitHub, GitLab, Forgejo, and Gmail.

A Channel tells the Agent where a message came from. It does not prove who sent it. [Trusted Invokers](/docs/agents/trusted-invokers) carry the trusted identity.

### Invocations and traces

Each run is an [Invocation](/docs/agents/invocations). ViteHub records it as events: text, tool calls, approvals, usage, errors, and the final state. `vitehub agent info` prints the resolved Agent Definition. The [Console](/docs/development/console) shows each run.

An in-memory trace does not survive a restart. Keep records with [Invocation storage](/docs/agents/invocation-storage) or an [OTLP receiver](/docs/agents/capabilities/otlp). [Evals](/docs/agents/evals) run the same scenarios against an Agent each time and score the result.

### Run it on any host

ViteHub builds Agents for Node, Docker, Cloudflare, Vercel, Netlify, and Deno. Model and `run` Drivers skip the Node-only provider code, so they also run in a Cloudflare Worker.

Codex and Claude Code start local processes, so provider Drivers need a Node.js host. Provider Workspaces and Sandboxes also need POSIX, not Windows. A Worker build that selects a provider Driver fails with `AGENT_B0019`. The [support matrix](/docs/frameworks-hosts/support-matrix) lists what each host supports.

## Start building

- [First Agent](/docs/getting-started/first-agent) runs an Agent without a model or an API key.
- [Build a chat app](/docs/agents/build-a-chat-app) connects a model, a streaming route, and a Vue chat UI.
- [Learning path](/docs/agents/get-started) goes from the first run to a complete application.
