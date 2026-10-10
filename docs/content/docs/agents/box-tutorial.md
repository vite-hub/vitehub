---
title: Run your first Box
description: "Open a trusted-host Box, run one command, and inspect the result."
layout: tutorial
navigation.title: Box tutorial
navigation.order: 49
navigation.group: Advanced execution
icon: i-lucide-rocket
---

Open a Box on your own Node host, write a text file, and run Node to read it. The response will contain `Box is ready`. A Box prepares an execution session with a private Home, declared environment, and boot checks.

You need Node.js 24.15 or newer, pnpm, and a Vite server application. Run the commands from its root. A trusted-host Box shares the host's filesystem and process authority. Use [Sandbox](/docs/sandbox) when untrusted code needs provider-managed isolation.

::tutorial-step{title="Install the Box package"}
## Install the Box package

Install Box and Nitro in your Vite app. Add Nitro to its existing Vite config so it serves the route below.

```bash [commands/install]
pnpm add @vite-hub/box nitro h3
```

The package includes the `resolveBox()` helper and the portable Box session
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

Create a route that opens a trusted-host Box, writes one file, and runs Node.js
against it:

`requires: ['node']` checks that Node is available before the session opens. The route writes through the session's file API, executes Node, then returns its output. Keep the `finally` block so a failed command also closes the session.

```ts [server/api/box-check.get.ts]
import { defineEventHandler } from "h3";
import { resolveBox } from "@vite-hub/box";

export default defineEventHandler(async () => {
  const box = await resolveBox(
    {
      runtime: "trusted-host",
      cwd: process.cwd(),
      requires: ["node"],
    },
    {},
  );

  const session = await box.open();
  try {
    await session.files.write(
      "workspace/.vitehub/box-check.txt",
      new TextEncoder().encode("Box is ready\n"),
    );
    const result = await session.exec(
      "node",
      ["-e", "process.stdout.write(require('fs').readFileSync('.vitehub/box-check.txt', 'utf8'))"],
      { cwd: session.cwd },
    );

    if (!result.ok) throw new Error(result.stderr);
    return { runtime: box.plan.runtime, output: result.stdout };
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
curl http://localhost:5173/api/box-check
```

The response contains:

```json [output/response.json]
{
  "runtime": "trusted-host",
  "output": "Box is ready\n"
}
```

Read [Boxes](/docs/agents/boxes) for checkouts, private Home files, durable
state, toolchain provisioning, and remote runtimes. A Box owns execution. A
[Workspace](/docs/agents/workspace-context) owns Agent-visible files.
::
