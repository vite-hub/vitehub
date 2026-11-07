---
title: Run your first Shell command
description: Search a read-only Workspace with Just Bash and inspect the command output.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You write an API route that runs one shell command, `rg auth .`, on a Markdown file. The route returns the matching line and the command's exit code.

You need:

- Node.js 22.22 or newer
- pnpm
- a Vite app. Run every command from its root folder.

You do not need a cloud account, a container, or a real shell on the server.

::tutorial-step{title="Install"}
## Install

Install the packages:

```bash [commands/install]
pnpm add @vite-hub/shell @vite-hub/workspace nitro h3
pnpm add -D vite
```

- `@vite-hub/shell` runs the command.
- `@vite-hub/workspace` holds the file that the command searches. A Workspace is a folder of files that the server can read and write.
- `nitro` and `h3` serve the API route. `vite` runs the dev server.

Add the plugins to `vite.config.ts`. `hubWorkspace()` finds the files in `server/workspaces/`. Shell does not need a plugin, because the route creates it.

```ts [vite.config.ts]
import { hubWorkspace } from '@vite-hub/workspace/vite'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [hubWorkspace(), nitro()],
})
```

Create `server/workspaces/docs.ts`. This is the `docs` Workspace. ViteHub uses the file name as its name.

```ts [server/workspaces/docs.ts]
import { defineWorkspace } from '@vite-hub/workspace'

export default defineWorkspace({
  store: { provider: 'memory' },
  rules: {
    '/**': { write: true, mediaType: 'text/markdown' },
  },
})
```

- `store: { provider: 'memory' }` keeps the files in the server process. A restart deletes them.
- `rules` lets the server write every file (`/**`) as Markdown.

::

::tutorial-step{title="Run one command"}
## Run one command

Create `server/api/search-docs.get.ts`. The route writes a `README.md` file to the Workspace. Then it runs `rg auth .`, which searches all files in the current folder for the word `auth`.

```ts [server/api/search-docs.get.ts]
import { defineEventHandler } from 'h3'
import { createShellRuntime } from '@vite-hub/shell'
import { createJustBashProvider } from '@vite-hub/shell/providers/just-bash'
import { createReadonlyWorkspaceFs, workspaceMountPoint } from '@vite-hub/shell/workspace'
import { useWorkspace } from '@vite-hub/workspace'

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

- `policy` limits the shell. It allows one command (`maxShellCalls: 1`), keeps at most 10,000 characters of output, and stops after 30 seconds.
- `createJustBashProvider()` runs commands in Just Bash. Just Bash runs Bash commands inside the Node.js process, on a virtual file system. It does not start a real shell.
- `commands` allows only `pwd`, `ls`, `cat`, and `rg`. The commands have no network access.
- `createReadonlyWorkspaceFs()` gives the shell the Workspace files as read-only. The route can write files, but the command cannot.
- `cwd: workspaceMountPoint` starts the command in the folder where the Workspace files are.

::

::tutorial-step{title="Call the route"}
## Call the route

Start the dev server:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. Open a second terminal and call the route:

```bash [commands/request]
curl http://localhost:5173/api/search-docs
```

You see:

```json [output/response.json]
{
  "event": "command_finished",
  "exitCode": 0,
  "stdout": "README.md:1:# ViteHub auth\n"
}
```

`exitCode: 0` means that the command finished without an error. `stdout` shows that `rg` found `auth` on line 1 of `README.md`. This proves that the shell can read the Workspace file.

::

## Next steps

- [Server API](/docs/shell/server-api): keep a shell session open, and check a command before you run it.
- [Configure](/docs/shell/configure): set what each provider can reach, and change the limits.
- [Sandbox](/docs/sandbox): run real programs on a separate, isolated machine.
