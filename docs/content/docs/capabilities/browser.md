---
title: Browser
description: Give an Agent headless browser access through the global bash tool.
navigation.title: Browser
navigation.order: 62
navigation.group: Workspace
icon: i-lucide-monitor
---

`browser()` lets an Agent run the `agent-browser` CLI through ViteHub's global `bash` tool.
Use it when a model-backed Agent needs browser evidence, screenshots, or DOM inspection during an invocation.

Use the [Browser server primitive](/docs/server-primitives/browser) when trusted server code needs provider-backed Browser Sessions, Cloudflare Browser Run output, or live handoff between server steps. The Capability and primitive are separate surfaces: the Capability grants a model-facing command, while the primitive owns server-side Browser Session lifecycle.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
The application must make the configured browser command available before the Agent runs.

## What it adds

The Capability contributes `agent-browser` to the global `bash` tool with the description `Run headless browser.`
It also contributes a Workspace Source at `skills/browser/SKILL.md`.
The skill file explains how the Agent should call the CLI and save browser artifacts in the Workspace.

`browser()` does not add a custom `agent_browser` tool.
It also does not install packages during an invocation.
It does not claim or share `@vite-hub/browser` sessions.

## Configuration

Attach `browser()` to an Agent with a writable Workspace.

```ts [server/agents/review.ts]
import { defineAgent } from '@vite-hub/agent'
import { browser } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  workspace: { name: 'review', mode: 'write' },
  capabilities: [
    browser(),
  ],
})
```

Use `command` only when the executable name differs from `agent-browser`.

## Runtime behavior

ViteHub merges Capability `bash` contributions into one model-facing `bash` tool.
The browser command appears beside other registered commands, and the tool schema restricts calls to registered executable names.

The Agent can run the command with structured args:

```ts [Agent tool call]
await bash({
  command: 'agent-browser',
  args: ['--help'],
})
```

When another Capability uploads browser artifacts, keep that upload behavior with that Capability.
For example, Blob write tools document Workspace file uploads through `workspacePath`.

## Requirements

`browser()` requires an explicit Workspace with `workspace.mode: 'write'`.
The configured command must resolve in the Workspace Session environment before the invocation starts.

The browser skill is a Workspace Source contribution.
ViteHub materializes it through the normal Workspace Source flow, so it remains inspectable with other contributed Sources.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives the global `bash` tool with the browser command registered. |
| Harness-backed | Receives the global `bash` tool through the Harness tool bridge and the contributed browser skill file through Workspace materialization. |
| Custom-run-backed | Receives prepared Workspace context; `driver.run` decides whether to use Workspace APIs directly. |

## Inspect and verify

Inspect the Agent tool list in DevTools.
An Agent with `browser()` should expose `bash`, and the `bash` schema should list `agent-browser` as an allowed command.

Inspect the Workspace Sources for `skill.browser`.
The source should materialize `skills/browser/SKILL.md`.

Run one invocation that calls `agent-browser --help` through `bash`.
Then save a screenshot under `screenshots/` and verify the Workspace contains the artifact.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `command` | `string` | `"agent-browser"` | Executable name registered on the global `bash` tool. |
| `skillContent` | `string` | built-in browser skill | Markdown content for `skills/browser/SKILL.md`. |
| `skillPath` | `string` | `"skills/browser/SKILL.md"` | Workspace path for the contributed browser skill. |
| `sourceKey` | `string` | `"skill.browser"` | Workspace Source key for the contributed skill file. |

## Reference

- [Browser primitive](/docs/server-primitives/browser)
- [Blob](/docs/capabilities/blob)
- [Workspace shell](/docs/capabilities/workspace-shell)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
- Source: `packages/agent/src/capabilities/browser.ts`
