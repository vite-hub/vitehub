---
title: Browser
description: Give a Provider Agent a ready-to-use headless browser.
navigation.title: Browser
navigation.order: 62
navigation.group: Workspace
icon: i-lucide-monitor
---

Attach `browser()` to give a Provider Agent the `agent-browser` CLI, Chromium, and the official browser Skill. ViteHub prepares the runtime before the provider starts, reuses its cache, and checks that Chromium can launch.

```ts [server/agents/review.ts]
import { defineAgent } from 'vite-hub/agent'
import { browser } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { kind: 'codex', model: 'gpt-6-astra' },
  workspace: { mode: 'write' },
  capabilities: [browser()],
})
```

The Skill is materialized at `.agents/skills/agent-browser/SKILL.md`. It directs the provider to load the version-matched workflow with `agent-browser skills get core`. The CLI runs through the provider's native shell. Each invocation receives its own default browser session, which the Capability closes when the invocation finishes.

Save screenshots under `screenshots/`. A final-reply marker such as `![Login page](screenshots/login.png)` attaches the changed file to the reply. Use an artifact publisher for other files or permanent public links.

## Managed runtime

The default supports local Node deployments on Linux x64 and macOS. The initial preparation requires `npm` and network access. It installs pinned CLI dependencies into a versioned cache; subsequent invocations reuse them. Linux includes Chromium's shared libraries and fonts, so Debian slim containers do not need browser-specific APT installation commands. The managed Linux browser runs without Chromium's sandbox and inherits the enclosing provider's execution boundary.

The cache uses `VITEHUB_CACHE_DIR`, otherwise `$XDG_CACHE_HOME/vitehub`, otherwise `~/.cache/vitehub`. Keep this directory on persistent storage for containers. Browser sockets use a short private temporary directory. The Capability supplies its environment only to the enclosing invocation and does not replace the provider's home directory or credentials.

A missing executable, corrupt cache, or failed launch is detected before the provider starts. Failed installations can be retried. Other platforms and remote launchers require an externally prepared runtime.

For Codex, the managed runtime disables login shells so shell profiles cannot replace the browser CLI path. Other shell commands keep the invocation environment.

## External runtime

For SSH launchers, install the CLI and browser on the remote host and use `browser({ runtime: 'external' })`. The Capability still supplies workspace guidance and screenshot delivery. The remote provider owns executable discovery and browser setup.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `runtime` | `"managed" \| "external"` | `"managed"` | Prepare a local runtime, or use an externally prepared one. |
| `command` | `string` | `"agent-browser"` | Executable name named in the Skill. A custom command selects an external runtime unless `runtime` is explicit. |
| `skillContent` | `string` | official installed Skill | Override the mounted Markdown guidance. |
| `skillPath` | `string` | `".agents/skills/agent-browser/SKILL.md"` | Workspace path for the Skill. |
| `sourceKey` | `string` | `"skill.browser"` | Workspace Source key for the Skill file. |

Model-backed and custom Drivers are unsupported because they do not own the required provider shell. Use the [Browser primitive](/docs/server-primitives/browser) when trusted server code owns the Browser Session lifecycle.
