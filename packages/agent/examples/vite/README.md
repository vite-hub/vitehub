# Offline Agent with Vite

This example defines one Agent, discovers it through Vite, and invokes it without a model API key. Its custom `driver.run` returns a fixed-format greeting, so the same input always produces the same output.

You need Node.js 24.15 or newer and pnpm. From the repository root, install the workspace dependencies, then enter this example:

```sh
corepack pnpm install
cd packages/agent/examples/vite
```

## Inspect and invoke the Agent

Start the Vite Development Server:

```sh
pnpm dev
```

Keep it running, then use another terminal in this directory to inspect the discovered Definition:

```sh
pnpm vitehub agent info --agent greeting --json
```

The JSON includes these fields:

```json
{
  "config": {
    "driver": {
      "kind": "run"
    }
  },
  "name": "greeting"
}
```

Invoke the Agent through the local Agent Dev Loop:

```sh
pnpm vitehub agent dev --agent greeting --prompt Ada
```

Expected output:

```txt
Hello, Ada. This Agent ran without credentials.
```

Stop the Vite server with `Ctrl+C` when you finish. The Agent Dev Loop is a local development endpoint, not an authenticated production API. Do not expose it publicly.

## Build the application route

`src/server.ts` also shows an application-owned H3 route that calls the same Definition with `runAgent()`:

```sh
pnpm build
```

The build writes `dist/server.js`. That file is a server bundle, not a running server or deployment. A host integration must mount the exported H3 app, provide its process lifecycle, and connect `waitUntil` to the host's real request lifetime.

The `/greet` route has no authentication or runtime input validation. Treat it as learning and test code. Authenticate callers and validate untrusted request data before adapting it for a public application.

The custom Driver also runs as ordinary application code in the Vite or host process. It has no model credentials, but it is not isolated or sandboxed. Replace it with a model or coding provider only when you are ready to configure that provider's credentials, authority, cost, timeout, and deployment requirements.
