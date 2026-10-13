---
title: Git
description: Give an Agent bounded Git source-history access inside a Workspace Session.
navigation.title: Git
navigation.order: 165
navigation.group: Capabilities
icon: i-lucide-git-branch
---

`git()` adds one model-facing `shell` tool that runs controlled Git commands in a [Workspace](/docs/workspace) Session. Read mode allows source-history inspection. Write mode also allows local `fetch`, `checkout`, and `switch`. Use it for review, source-history inspection, and local branch selection, not to publish repository history.

The [Workspace server API](/docs/workspace/server-api) covers application code. This page covers the Agent tool.

## Configure Git access

```ts [server/agents/reviewer.ts]
import { defineAgent } from 'vite-hub/agent'
import { git } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  workspace,
  capabilities: [
    git({ mode: 'read' }),
  ],
})
```

Require approval for write commands:

```ts [server/agents/reviewer.ts]
import { defineAgent } from 'vite-hub/agent'
import { git } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  workspace,
  capabilities: [
    git({ mode: 'write', policy: 'require-approval' }),
  ],
})
```

## Agent-visible tool contract

`shell` accepts this input:

| Field | Type | Description |
| --- | --- | --- |
| `command` | `string` | One Git command, for example `git status --short`. A bare subcommand such as `status --short` is normalized to start with `git`. |
| `cwd` | `string` | Optional Workspace-relative directory. Defaults to the pull request checkout when one exists, otherwise the Workspace root. |

The result has `command`, `args`, `cwd`, `exitCode`, `stdout`, `stderr`, and `outputTruncated`.

## How Git access works

`shell` accepts one `git` command without shell composition. It rejects `|`, `;`, `<`, `>`, `&`, newlines, and global Git flags such as `git -C`. Use `cwd` to select a directory.

Read mode allows `blame`, `cat-file`, `describe`, `diff`, `for-each-ref`, `grep`, `log`, `ls-files`, `merge-base`, `rev-list`, `rev-parse`, `shortlog`, `show`, `show-ref`, and `status`. It rejects options that write files or run external programs, such as `--output`, `-O`, `--ext-diff`, `--textconv`, `--no-index`, `--contents`, and `--open-files-in-pager`.

Write mode also allows `fetch`, `checkout`, and `switch`, only on a clean working tree:

- `fetch` accepts only remotes that `git remote` lists. It rejects remote URLs, refspecs that update local refs (`+` or `:`), and options such as `--force`, `--tags`, and `--upload-pack`.
- `checkout` rejects branch creation and force options such as `-b`, `-B`, `--orphan`, `-f`, and `--merge`.
- `switch` rejects branch creation and force options such as `-c`, `-C`, `--create`, `--force`, and `--discard-changes`.

ViteHub always blocks `commit`, `push`, `reset`, `rebase`, and `tag`. Arguments must stay inside the Workspace. Git runs with `GIT_TERMINAL_PROMPT=0` and no pager.

The Capability reuses its Workspace Sessions within one invocation and closes them when the invocation finishes. A successful write command commits the session changes to the Workspace, except in a pull request checkout.

### Pull request checkouts

In a GitHub pull request Invocation, the first command prepares the pull request mount as a Git checkout of the exact head SHA. The checkout and `fetch` use the Agent GitHub identity from `defineAgent({ github })`. Without one, they run without credentials.

## Requirements

`git()` requires a Workspace that can start a Workspace Session with `git` available. The Workspace requirement is write mode, even for `mode: 'read'`, because ViteHub may need session-local Git state.

## Security and approval

The Agent can run only the commands and options listed above. The `policy` option applies only to write commands (`fetch`, `checkout`, `switch`). Read commands are always allowed.

- `"allow"` (default): run write commands without approval.
- `"require-approval"`: stop the call with an approval request. The command runs after a user approves it.
- `"deny"`: reject write commands.
- A function receives `{ name, input }` and returns one of these values.

A policy cannot enable a blocked command. `fetch` can use the Agent GitHub identity in a pull request Invocation. No other credentials are added. `maxOutputLength` limits the stdout and stderr returned to the model; it does not limit the command.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives the `shell` tool. |
| Provider-backed | Receives the `shell` tool through the provider MCP bridge. |
| Custom-run-backed | Receives the `shell` tool in `driver.run({ tools })`. |

## Verify Git access

1. Run `vitehub agent info --agent <name> --json` and confirm that `tools` contains a `git` entry. Entries use the Capability id. The Agent receives the tool as `shell`.
2. Run `git status --short` through `shell` and confirm a zero `exitCode`.
3. Run `git push` through `shell` and confirm that it fails with `git push is not available through git()`.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"read" \| "write"` | `"read"` | Set to `"write"` to allow local `fetch`, `checkout`, and `switch`. |
| `maxOutputLength` | `number` | `Infinity` | Maximum stdout and stderr characters returned per command. Longer output is truncated. |
| `policy` | `AgentToolPolicyDecision \| function` | `"allow"` | Policy for write commands. Read commands remain allowed. |
| `timeout` | `number` | `60000` | Timeout in milliseconds for each Git command in the Workspace Session. |

## Related pages

- [Workspace primitive](/docs/workspace)
- [Workspace shell](/docs/workspace/agent-capability)
- [Official Capabilities](/docs/agents/capabilities/official)
