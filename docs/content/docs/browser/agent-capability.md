---
title: Browser capability
description: Give a Provider Agent the agent-browser CLI, headless Chromium, and the official browser Skill.
navigation.title: Agent capability
navigation.order: 5
icon: i-lucide-monitor
---

`browser()` gives a Provider Agent (an Agent that Codex or Claude Code runs) the `agent-browser` CLI, Chromium, and the official browser Skill. The Agent runs the CLI in the provider's own shell.

For Browser Sessions in your own app code, read the [Browser server API](/docs/browser/server-api).

## Configure the browser

```ts [server/agents/review.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'
import { browser } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: codexDriver({ model: 'gpt-6-astra' }),
  workspace: { mode: 'write' },
  capabilities: [browser()],
})
```

## How the browser works

In managed mode, ViteHub prepares the runtime before the provider starts, reuses its cache, and checks that Chromium can launch. In external mode, the provider environment must already have the CLI and browser.

The Skill file is written to `.agents/skills/agent-browser/SKILL.md`. In managed mode, it is the official Skill from the installed CLI. It tells the provider to load the matching workflow with `agent-browser skills get core`, and to run browser commands only when `VITEHUB_BROWSER_ACTIVE` is `1`.

In managed mode, each Invocation (one Agent run) gets its own browser session through `AGENT_BROWSER_SESSION`. The Capability closes it when the run ends.

### Screenshots

Save screenshots under `screenshots/`, where the Agent can write and commit. A marker in the final reply, such as `![Login page](screenshots/login.png)`, attaches the file and is removed from the text. Only `.png`, `.jpg`, `.jpeg`, and `.webp` files that the run added or changed are attached. For other files or permanent public links, use an artifact publisher.

### Managed runtime

The managed runtime runs on local Node. The first setup installs pinned CLI dependencies into a versioned cache for later runs. On Linux, it includes Chromium's shared libraries and fonts, so Debian slim containers need no extra APT packages.

The cache is `VITEHUB_CACHE_DIR`, else `$XDG_CACHE_HOME/vitehub`, else `~/.cache/vitehub`. In containers, keep it on persistent storage. Browser sockets use a short private temporary directory. The Capability sets its environment only for its own run, and keeps the provider's home directory and credentials.

A missing executable, corrupt cache, or failed launch shows before the provider starts. You can retry a failed install.

For Codex, the managed runtime turns off login shells, so shell profiles cannot change the browser CLI path. Other shell commands keep the run environment.

### External runtime

Use the external runtime on other platforms and remote launchers. For SSH, install the CLI and browser on the remote host. If `runtime` is not set, a Driver `launch` or a custom `command` selects it. The Capability still supplies the Skill and screenshots. The provider finds the executable and sets up the browser.

Inspection metadata reports `runtime: 'auto'` when the runtime depends on the Driver.

## Requirements

- A Provider Agent Driver. Other Drivers fail with `browser() requires a Provider Agent Driver.`
- A Workspace with `mode: 'write'`.
- Managed runtime: Linux x64 or macOS, `npm`, and network access for the first setup.
- External runtime: the `agent-browser` CLI or the configured `command`, and a browser in the provider environment.

## Security and approval

`browser()` adds no model tool and has no `policy` option. The provider runs the CLI in its own shell, so the Driver's permission settings control those commands.

- The browser can reach any URL the provider host can reach. The Capability does not limit network access.
- The managed Linux browser runs without Chromium's sandbox. The provider's isolation is the boundary.
- Paths outside `screenshots/**` follow the Workspace rules.
- `command` must be one executable name. `runtime: 'managed'` with a custom `command` fails when the Agent is defined. `runtime: 'managed'` with `driver.launch` fails before the provider starts.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Not supported. The Driver has no provider shell. |
| Provider-backed | Supported. Gets the CLI, browser runtime, Skill, and screenshots. |
| Custom-run-backed | Not supported. Use the [Browser primitive](/docs/browser) in `driver.run`. |

## Verify the browser

1. Run `vitehub agent info --agent <name> --json`. Confirm that the `browser` metadata shows `command`, `runtime`, `skillPath`, and `sourceKey`.
2. Run the Agent once with `vitehub agent dev --agent <name> --prompt "Open https://example.com and take a screenshot"`.
3. Confirm that the reply has no screenshot marker and the result lists the `screenshots/...` file as an artifact with `placement: 'attachment'`.
4. For the managed runtime, confirm that the cache directory holds the prepared runtime.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `runtime` | `"managed" \| "external"` | `"external"` with a custom `command` or `driver.launch`, otherwise `"managed"` | Prepare a local runtime, or use one prepared elsewhere. |
| `command` | `string` | `"agent-browser"` | Executable name in the default Skill. |
| `skillContent` | `string` | official installed Skill in managed mode | Replace the Skill Markdown. |
| `skillPath` | `string` | `".agents/skills/agent-browser/SKILL.md"` | Workspace path for the Skill. |
| `sourceKey` | `string` | `"skill.browser"` | Workspace Source key for the Skill file. |

## Related pages

- [Browser primitive](/docs/browser)
- [Agent Drivers](/docs/agents/agent-drivers)
- [skills()](/docs/agents/capabilities/skills)
- [Official Capabilities](/docs/agents/capabilities/official)
