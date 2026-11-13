---

title: Run your first Shell command
description: Search a read-only Workspace with Just Bash and inspect the command output.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Shell lets your server run simple shell commands, such as `ls`, `cat`, and `rg`, on files that you choose. You decide which commands are allowed, and how long and how much output each one can have.

In this tutorial, you write a Markdown file, search it with `rg`, and return the matching line from an API route. You check the exit code and the output of the command.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation). Run every command from the app root. You need no account. This tutorial uses Just Bash, which runs the commands inside your server process, only on the files you give it. It is not a separate machine. To run other programs in isolation, use [Sandbox](/docs/sandbox).

::tutorial-step{title="Install and configure"}
## Install and configure

Shell runs its commands on the files of a Workspace. A Workspace is a folder of files that your server can read and write.

Install Shell and Workspace:

```bash pm [commands/install]
pnpm add @vite-hub/shell @vite-hub/workspace valibot
```

Add `workspace: true` to the ViteHub options of your app. Keep the other options of your app. Shell needs no option, because your route creates it.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node', workspace: true },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', workspace: true }), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', workspace: true })],
})
```
::::
:::


Create `server/workspaces/docs.ts`. This is the `docs` Workspace that holds your file:

```ts [server/workspaces/docs.ts]
import { defineWorkspace } from 'vite-hub/workspace'

export default defineWorkspace({
  store: { provider: 'memory' },
  rules: {
    '/**': { write: true, mediaType: 'text/markdown' },
  },
})
```

- `provider: 'memory'` keeps the files in memory. A server restart loses them.
- `write: true` lets your route write Markdown files to the Workspace.

::

::tutorial-step{title="Run one command"}
## Run one command

Create `server/api/search-docs.get.ts`. This route writes `README.md` to the Workspace, then searches it for the word `auth`.

```ts [server/api/search-docs.get.ts]
import { defineEventHandler } from 'h3'
import { createShellRuntime } from 'vite-hub/shell'
import { createJustBashProvider } from 'vite-hub/shell/providers/just-bash'
import { createReadonlyWorkspaceFs, workspaceMountPoint } from 'vite-hub/shell/workspace'
import { useWorkspace } from 'vite-hub/workspace'

export default defineEventHandler(async () => {
  const workspace = useWorkspace('docs', { mode: 'write' })
  await workspace.fs.writeFile('README.md', '# ViteHub auth\n')

  const shell = createShellRuntime({
    policy: { maxOutputLength: 10_000, maxShellCalls: 1, timeout: 30_000 },
    provider: createJustBashProvider({
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

- `policy` allows one command, keeps at most 10,000 characters of output, and stops the command after 30 seconds.
- `commands` lists the only commands that Shell can run: `pwd`, `ls`, `cat`, and `rg`. Shell has no network access.
- `createReadonlyWorkspaceFs(workspace.fs)` gives Shell the Workspace files, but it cannot change them. The route can still write, because it opened the Workspace with `mode: 'write'`.
- `shell.exec('rg auth .')` runs the search and returns the result: its exit code and its output.

::

::tutorial-step{title="Run and check the result"}
## Run and check the result

Start the dev server:

```bash [commands/start]
pnpm dev
```

Open a second terminal, and call the route:

```bash [commands/request]
curl http://localhost:3000/api/search-docs
```

The response shows that the command worked. Exit code `0` means success, and `stdout` has the matching line:

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
Keep a Shell session open and check a command before it runs.
:::

:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/shell/configure"}
Set the provider, its limits, and network access.
:::
::
