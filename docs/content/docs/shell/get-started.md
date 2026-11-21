---

title: Run your first Shell command
description: Search a read-only Workspace with Just Bash and inspect the command output.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Shell lets your server run simple shell commands, such as `ls`, `cat`, and `rg`, on files that you choose. You decide which commands are allowed, how long each command can run, and how much output it can return.

In this tutorial, you write a Markdown file to a Workspace, search it with `rg`, and return the exit code and matching line from an API route.

> [!NOTE] Before you start
> Start with the app from [Installation](/docs/getting-started/installation) and run commands from the app root. You do not need an account. This tutorial uses Just Bash, which runs the commands inside your server process, only on the files that you give it. It is not a separate machine. To run other programs in isolation, use [Sandbox](/docs/sandbox).

::tutorial-step{title="Install and define a Workspace"}
## Install and define a Workspace

Shell runs commands on the files of a Workspace. A Workspace is a folder of files that your server can read and write.

Install Shell, Workspace, and Valibot:

```bash pm [commands/install]
pnpm add @vite-hub/shell @vite-hub/workspace valibot
```

Create `server/workspaces/docs.ts` to define the `docs` Workspace that holds your file. This file turns Workspace on. Shell needs no option, because your route creates it:

```ts [server/workspaces/docs.ts]
import { defineWorkspace } from 'vite-hub/workspace'

export default defineWorkspace({
  store: { driver: 'memory' },
  rules: {
    '/**': { write: true, mediaType: 'text/markdown' },
  },
})
```

- `driver: 'memory'` stores files in process memory, which resets when the server restarts.
- `write: true` allows your route to write Markdown files into the Workspace.

::

::tutorial-step{title="Run one command"}
## Run one command

Create `server/api/search-docs.get.ts` to write `README.md` into the Workspace and search it for `auth`.

```ts [server/api/search-docs.get.ts]
import { defineEventHandler } from 'h3'
import { createShellRuntime } from 'vite-hub/shell'
import { createJustBashDriver } from 'vite-hub/shell/providers/just-bash'
import { createReadonlyWorkspaceFs, workspaceMountPoint } from 'vite-hub/shell/workspace'
import { useWorkspace } from 'vite-hub/workspace'

export default defineEventHandler(async () => {
  const workspace = useWorkspace('docs', { mode: 'write' })
  await workspace.fs.writeFile('README.md', '# ViteHub auth\n')

  const shell = createShellRuntime({
    policy: { maxOutputLength: 10_000, maxShellCalls: 1, timeout: 30_000 },
    driver: createJustBashDriver({
      commands: ['pwd', 'ls', 'cat', 'rg'],
      cwd: workspaceMountPoint,
      fs: createReadonlyWorkspaceFs(workspace.fs),
    }),
  })

  const observation = await shell.exec('rg auth .', { cwd: workspaceMountPoint })
  return {
    event: observation.event,
    exitCode: observation.exitCode,
    stdout: observation.stdout,
  }
})
```

- `policy` allows one command call, caps output at 10,000 characters, and stops the command after 30 seconds.
- `commands` limits the shell to `pwd`, `ls`, `cat`, and `rg`. Shell has no network access.
- `createReadonlyWorkspaceFs(workspace.fs)` gives Shell the Workspace files, but Shell cannot change them. The route can still write, because it opened the Workspace with `mode: 'write'`.
- `shell.exec('rg auth .')` runs the search and returns its exit code and output.

::

::tutorial-step{title="Run and check the result"}
## Run and check the result

Start the dev server:

```bash [commands/start]
pnpm dev
```

From a second terminal, call the route:

```bash [commands/request]
curl http://localhost:3000/api/search-docs
```

Exit code `0` confirms the search succeeded, and `stdout` contains the matching line:

```json [output/response.json]
{
  "event": "command_finished",
  "exitCode": 0,
  "stdout": "README.md:1:# ViteHub auth\n"
}
```

::

## Next steps

::card-group
:::card{title="Server API" icon="i-lucide-code" to="/docs/shell/server-api"}
Keep a Shell session open across calls, and check a command before it runs.
:::

:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/shell/configure"}
Set the Shell driver, its limits, and network access.
:::
::
