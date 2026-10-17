---
title: Run your first Sandbox
description: "Open a trusted-host Sandbox, run one command, and inspect the result."
layout: tutorial
navigation.title: Sandbox tutorial
navigation.order: 49
navigation.group: Advanced execution
icon: i-lucide-rocket
---

Open a Sandbox on your own Node host, write a text file, and run Node to read it. The response will contain `Sandbox is ready`. A Sandbox prepares an execution session with a private Home, declared environment, and boot checks.

You need Node.js 24.15 or newer, pnpm, and a Vite server application. Run the commands from its root. A trusted-host Sandbox shares the host's filesystem and process authority. Use [Sandbox](/docs/sandbox) when untrusted code needs provider-managed isolation.

::tutorial-step{title="Install the Sandbox package"}
## Install the Sandbox package

Install Sandbox and Nitro in your Vite app. Add Nitro to its existing Vite config so it serves the route below.

```bash [commands/install]
pnpm add @vite-hub/sandbox nitro h3
```

The package includes the `resolveSandbox()` helper and the portable Sandbox session
contracts. It does not install a provider SDK for you. Register Nitro so the
`server/api` route is served by the same Vite development server:

```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [nitro() as never],
})
```
::

::tutorial-step{title="Open a session"}
## Open a session

Create a route that opens a trusted-host Sandbox, writes one file, and runs Node.js
against it:

`requires: ['node']` checks that Node is available before the session opens. The route writes through the session's file API, executes Node, then returns its output. Keep the `finally` block so a failed command also closes the session.

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

`close()` runs in `finally` so the session releases its processes and temporary
state when the command fails as well as when it succeeds.
::

::tutorial-step{title="Run and check the result"}
## Run and check the result

Start the server and call the route:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. In another terminal, run:

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
state, toolchain provisioning, and remote runtimes. A Sandbox owns execution. A
[Workspace](/docs/agents/workspace-context) owns Agent-visible files.
::
