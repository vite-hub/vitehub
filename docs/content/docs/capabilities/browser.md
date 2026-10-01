---
title: Browser
description: Give a Provider Agent the agent-browser CLI, a headless Chromium, and the official browser Skill.
navigation.title: Browser
navigation.order: 62
navigation.group: Workspace
icon: i-lucide-monitor
---

`browser()` gives a Provider Agent the `agent-browser` CLI, Chromium, and the official browser Skill. The Agent runs the CLI through the provider's native shell. The Capability adds no model-facing tools.

The [Browser primitive](/docs/server-primitives/browser) covers Browser Sessions that trusted application code owns. This page covers the browser runtime for a Provider Agent.

## Configure the browser

```ts [server/agents/review.ts]
import { defineAgent } from 'vite-hub/agent'
import { browser } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { kind: 'codex', model: 'gpt-6-astra' },
  workspace: { mode: 'write' },
  capabilities: [browser()],
})
```

## How the browser works

In managed mode, ViteHub prepares the runtime before the provider starts, reuses its cache, and checks that Chromium can launch. In external mode, the provider environment must already have the CLI and browser.

The Skill is materialized at `.agents/skills/agent-browser/SKILL.md`. In managed mode, the Skill is the official Skill from the installed CLI. It directs the provider to load the version-matched workflow with `agent-browser skills get core`. The Skill tells the provider to run browser commands only when `VITEHUB_BROWSER_ACTIVE` is `1`.

In managed mode, each Agent Invocation receives its own browser session through `AGENT_BROWSER_SESSION`. The Capability closes the session when the invocation finishes.

### Screenshots

The Capability lets the Agent write and commit files under `screenshots/`. Save screenshots there. A final-reply marker such as `![Login page](screenshots/login.png)` attaches the file to the reply and removes the marker from the text. Only `.png`, `.jpg`, `.jpeg`, and `.webp` files that the invocation added or changed are attached. Use an artifact publisher for other files or permanent public links.

### Managed runtime

The managed runtime supports local Node deployments on Linux x64 and macOS. The first preparation requires `npm` and network access. It installs pinned CLI dependencies into a versioned cache. Later invocations reuse them. On Linux, the runtime includes Chromium's shared libraries and fonts, so Debian slim containers do not need browser-specific APT packages. The managed Linux browser runs without Chromium's sandbox and inherits the execution boundary of the enclosing provider.

The cache uses `VITEHUB_CACHE_DIR`, otherwise `$XDG_CACHE_HOME/vitehub`, otherwise `~/.cache/vitehub`. Keep this directory on persistent storage in containers. Browser sockets use a short private temporary directory. The Capability supplies its environment only to the enclosing invocation. It does not replace the provider's home directory or credentials.

A missing executable, a corrupt cache, or a failed launch is detected before the provider starts. A failed installation can be retried.

For Codex, the managed runtime disables login shells so shell profiles cannot replace the browser CLI path. Other shell commands keep the invocation environment.

### External runtime

Use the external runtime on other platforms and for remote launchers. For SSH launchers, install the CLI and browser on the remote host. When the Driver sets `launch` and `runtime` is not set, `browser()` uses the external runtime for that invocation. A custom `command` also selects the external runtime unless `runtime` is set. The Capability still supplies the Skill and screenshot delivery. The remote provider owns executable discovery and browser setup.

Inspection metadata reports `runtime: 'auto'` when the runtime depends on the Driver.

## Requirements

- A Provider Agent Driver. Other Drivers fail with `browser() requires a Provider Agent Driver.`
- A Workspace with `mode: 'write'`.
- For the managed runtime: Linux x64 or macOS, `npm`, and network access for the first preparation.
- For the external runtime: the `agent-browser` CLI, or the configured `command`, and a browser prepared in the provider environment.

## Security and approval

`browser()` adds no model-facing tool and has no `policy` option. The provider runs the browser CLI with its native shell, so the Driver's own permission settings control those commands.

- The browser can reach any URL that the provider host can reach. The Capability does not restrict network access.
- The managed Linux browser runs without Chromium's sandbox. The provider's execution boundary is the isolation boundary.
- The Workspace rule for `screenshots/**` allows writes and commits. Other paths follow the Workspace rules.
- `command` must be a single executable name. `runtime: 'managed'` with a custom `command` fails at definition time. `runtime: 'managed'` with `driver.launch` fails before the provider starts.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Not supported. The Driver does not own a provider shell. |
| Provider-backed | Supported. Receives the CLI, browser runtime, Skill, and screenshot delivery. |
| Custom-run-backed | Not supported. Use the [Browser primitive](/docs/server-primitives/browser) in `driver.run`. |

## Verify the browser

1. Run `vitehub agent info --agent <name> --json` and confirm that the `browser` Capability metadata shows `command`, `runtime`, `skillPath`, and `sourceKey`.
2. Run the Agent once with `vitehub agent dev --agent <name> --prompt "Open https://example.com and take a screenshot"`.
3. Confirm that the reply text has no screenshot marker and that the result lists the `screenshots/...` file as an artifact with `placement: 'attachment'`.
4. For the managed runtime, confirm that the cache directory contains the prepared runtime.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `runtime` | `"managed" \| "external"` | `"external"` with a custom `command` or `driver.launch`, otherwise `"managed"` | Prepare a local runtime, or use an externally prepared one. |
| `command` | `string` | `"agent-browser"` | Executable name used in the default Skill. A custom command selects an external runtime unless `runtime` is set. |
| `skillContent` | `string` | official installed Skill in managed mode | Override the mounted Markdown guidance. |
| `skillPath` | `string` | `".agents/skills/agent-browser/SKILL.md"` | Workspace path for the Skill. |
| `sourceKey` | `string` | `"skill.browser"` | Workspace Source key for the Skill file. |

## Related pages

- [Browser primitive](/docs/server-primitives/browser)
- [Agent Drivers](/docs/agents/agent-drivers)
- [skills()](/docs/capabilities/skills)
- [Official Capabilities](/docs/capabilities/official-capabilities)
