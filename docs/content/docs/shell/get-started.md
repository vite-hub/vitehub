---

title: Run your first Shell command
description: Search a read-only Workspace with Just Bash and inspect the command output.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Search a Markdown file with `rg` and return the matching line from a server route. The route creates a file in a memory Workspace, then gives Shell read-only access to that file tree. You will check both the command's exit code and its output.

You need Node.js 24.15 or newer, pnpm, and a Vite application. Run the commands from its root. The Just Bash provider runs the commands you allow against the supplied filesystem. Use [Sandbox](/docs/sandbox) when you need provider-managed isolation for external programs.

::tutorial-step{title="Install and configure"}
## Install and configure

Install Shell and Workspace. Only Workspace needs a discovery plugin in this example; the route creates Shell directly.

```bash [commands/install]
pnpm add @vite-hub/shell @vite-hub/workspace nitro h3
pnpm add -D vite
```

Register Workspace discovery in `vite.config.ts`:

```ts [vite.config.ts]
import { hubWorkspace } from '@vite-hub/workspace/vite'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [hubWorkspace(), nitro() as never],
})
```

Create a writable memory Workspace for the local fixture:

```ts [server/workspaces/docs.ts]
import { defineWorkspace } from '@vite-hub/workspace'

export default defineWorkspace({
  store: { provider: 'memory' },
  rules: {
    '/**': { write: true, mediaType: 'text/markdown' },
  },
})
```

::

::tutorial-step{title="Run one command"}
## Run one command

`rg auth .` searches for `auth` in the mounted tree. The command policy permits one call, caps its output, and applies a timeout. The filesystem adapter denies writes even though the route created the fixture with write access.

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

Only `pwd`, `ls`, `cat`, and `rg` are available to this provider, and it has no network access.

::

::tutorial-step{title="Run and check the result"}
## Run and check the result

Start Vite and call the route:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. In another terminal, run:

```bash [commands/request]
curl http://localhost:5173/api/search-docs
```

The response contains a successful observation:

```json [output/response.json]
{
  "event": "command_finished",
  "exitCode": 0,
  "stdout": "README.md:1:# ViteHub auth\n"
}
```

Read [Server API](/docs/shell/server-api) for sessions and command analysis,
then [Configuration](/docs/shell/configure) for provider boundaries and policy.
::
