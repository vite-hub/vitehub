---
title: Run your first Sandbox
description: Install the Sandbox package, open a session on your own host, run one command, and check the result.
layout: tutorial
navigation.title: Sandbox tutorial
navigation.order: 76
navigation.group: Advanced
icon: i-lucide-rocket
navigation.kind: Tutorial
---

In this tutorial you open a Sandbox on your own Node host, write a file, and run Node to read it back. A Sandbox is a session for running commands, with a private Home, a set environment, and boot checks.

You need Node.js 22.22 or newer, pnpm, and a Vite server app. Run the commands from its root.

> [!WARNING]
> A trusted-host Sandbox shares your host's files and process rights. For untrusted code, use [Sandbox](/docs/sandbox) with provider isolation.

::tutorial-step{title="Install the Sandbox package"}
## Install the Sandbox package

Install Sandbox and Nitro:

```bash [commands/install]
pnpm add @vite-hub/sandbox nitro h3
```

The package gives you `resolveSandbox()` and the portable session types. It does
not install a provider SDK. Add Nitro to your Vite config so the Vite dev server
also serves `server/api` routes:

```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [nitro()],
})
```
::

::tutorial-step{title="Open a session"}
## Open a session

Create a route that opens a Sandbox, writes one file, and runs Node to read it.
`requires: ['node']` checks that Node exists before the session opens.

```ts [server/api/sandbox-check.get.ts]
import { defineEventHandler } from "h3";
import { resolveSandbox } from "@vite-hub/sandbox";

export default defineEventHandler(async () => {
  const sandbox = await resolveSandbox(
    {
      runtime: "trusted-host",
      cwd: process.cwd(),
      requires: ["node"],
    },
    {},
  );

  const session = await sandbox.open();
  try {
    await session.files.write(
      "workspace/.vitehub/sandbox-check.txt",
      new TextEncoder().encode("Sandbox is ready\n"),
    );
    const result = await session.exec(
      "node",
      ["-e", "process.stdout.write(require('fs').readFileSync('.vitehub/sandbox-check.txt', 'utf8'))"],
      { cwd: session.cwd },
    );

    if (!result.ok) throw new Error(result.stderr);
    return { runtime: sandbox.plan.runtime, output: result.stdout };
  } finally {
    await session.close();
  }
});
```

Keep `close()` in `finally`. The session then frees its processes and temporary
state also when the command fails.
::

::tutorial-step{title="Run and check the result"}
## Run and check the result

Start the server:

```bash [commands/start]
pnpm vite dev
```

In another terminal, call the route:

```bash [commands/request]
curl http://localhost:5173/api/sandbox-check
```

The response contains:

```json [output/response.json]
{
  "runtime": "trusted-host",
  "output": "Sandbox is ready\n"
}
```

Read [Sandboxes](/docs/agents/sandboxes) for checkouts, private Home files, durable
state, toolchains, and remote runtimes. A Sandbox runs commands. A
[Workspace](/docs/agents/workspace-context) holds the files an Agent sees.
::
