---
title: Git
description: Let an Agent read Git history, and optionally fetch and switch branches, inside a Workspace Session.
navigation.title: Git
navigation.order: 165
navigation.group: Capabilities
icon: i-lucide-git-branch
---

`git()` gives the Agent one `shell` tool for a limited set of Git commands in a [Workspace](/docs/workspace) Session, a working copy of your files for one run. Read mode reads history. Write mode adds local `fetch`, `checkout`, and `switch`. Use it to review code, read history, and select a local branch. It cannot publish history. App code uses the [Workspace server API](/docs/workspace/server-api).

## Configure Git access

```ts [server/agents/reviewer.ts] fragment
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

Set `policy` to require approval for each write:

```ts [server/agents/reviewer.ts] fragment
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

| Field | Type | Description |
| --- | --- | --- |
| `command` | `string` | One Git command, such as `git status --short`. A missing `git` prefix is added. |
| `cwd` | `string` | Optional Workspace-relative directory. Defaults to the pull request checkout, else the Workspace root. |

The result has `command`, `args`, `cwd`, `exitCode`, `stdout`, `stderr`, and `outputTruncated`.

## How Git access works

`shell` takes one `git` command, never a chain. It rejects `|`, `;`, `<`, `>`, `&`, newlines, and global flags such as `git -C`. Use `cwd` for the directory.

Read mode allows `blame`, `cat-file`, `describe`, `diff`, `for-each-ref`, `grep`, `log`, `ls-files`, `merge-base`, `rev-list`, `rev-parse`, `shortlog`, `show`, `show-ref`, and `status`. It rejects options that write files or run programs, such as `--output`, `-O`, `--ext-diff`, `--textconv`, `--no-index`, `--contents`, and `--open-files-in-pager`.

Write mode adds `fetch`, `checkout`, and `switch`, only on a clean working tree:

- `fetch` accepts only listed remotes. It rejects remote URLs, refspecs that update local refs (`+` or `:`), and options such as `--force`, `--tags`, and `--upload-pack`.
- `checkout` rejects branch creation and force options such as `-b`, `-B`, `--orphan`, `-f`, and `--merge`.
- `switch` rejects branch creation and force options such as `-c`, `-C`, `--create`, `--force`, and `--discard-changes`.

`commit`, `push`, `reset`, `rebase`, and `tag` are always blocked. Arguments stay inside the Workspace. Git runs with `GIT_TERMINAL_PROMPT=0` and no pager.

Sessions are reused during a run and closed at its end. After a successful write, session changes are saved to the Workspace, except in a pull request checkout.

### Pull request checkouts

When a GitHub pull request starts the run, the first command prepares its folder as a checkout of the exact head SHA:

- Checkout and `fetch` use the forge access of the Agent's github() Channel App.
- The token goes in `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`, scoped to the base and head repositories.
- Without a pull request, commands get credentials for the repositories of the Agent's GitHub Workspace Sources (files ViteHub mounts in the Workspace).
- Without a github() Channel App, there are no credentials.

See [GitHub Channel](/docs/agents/channels).

## Requirements

A Workspace that starts Sessions with `git` installed and allows write mode, even for `mode: 'read'`, since ViteHub can write Git state in the session.

## Security and approval

Only the commands and options above run. `policy` applies only to writes (`fetch`, `checkout`, `switch`); reads always run.

- `"allow"` (default): no approval.
- `"require-approval"`: runs after a user approves.
- `"deny"`: rejects writes.
- A function of `{ name, input }` returns one of these.

A policy cannot enable a blocked command. In a pull request run, `fetch` can use the Agent's forge access; no other credentials are added. `maxOutputLength` limits stdout and stderr for the model, not the command.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives the `shell` tool. |
| Provider-backed | Receives the `shell` tool through the provider MCP bridge. |
| Custom-run-backed | Receives the `shell` tool in `driver.run({ tools })`. |

## Verify Git access

1. `vitehub agent info --agent <name> --json` has a `git` entry in `tools` (keyed by Capability id; the Agent sees `shell`).
2. `git status --short` through `shell` returns `exitCode` zero.
3. `git push` fails with `git push is not available through git()`.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"read" \| "write"` | `"read"` | `"write"` allows local `fetch`, `checkout`, and `switch`. |
| `maxOutputLength` | `number` | `Infinity` | Maximum stdout and stderr characters per command. Longer output is truncated. |
| `policy` | `AgentToolPolicyDecision \| function` | `"allow"` | Policy for writes. Reads stay allowed. |
| `timeout` | `number` | `60000` | Milliseconds per Git command. |

## Related pages

- [Workspace primitive](/docs/workspace)
- [Workspace shell](/docs/workspace/agent-capability)
- [Official Capabilities](/docs/agents/capabilities/official)
