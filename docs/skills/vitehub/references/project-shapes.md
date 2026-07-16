# Project shapes

Use this when a task creates a project, spans more than one ViteHub feature, or leaves the file layout unclear.

## Inspect first

Read the installed manifest and exports, then open only the guide matching the primary lane. Use File conventions only when discovery layout is unclear:

- [Installation](https://vitehub.dev/raw/docs/getting-started/installation.md)
- [First Server Primitive](https://vitehub.dev/raw/docs/getting-started/first-server-primitive.md)
- [First Agent](https://vitehub.dev/raw/docs/getting-started/first-agent.md)
- [File conventions](https://vitehub.dev/raw/docs/reference/file-conventions.md)

## Coherent shapes

### Server Primitive

```text
package.json          package, scripts, Node version
pnpm-lock.yaml        exact resolved contract
vite.config.ts        ViteHub integration and provider choice
src/server.ts         application HTTP boundary and Runtime Helper
```

Add a discovered Definition under `server/` only when the primitive's docs require discovery. The proof must call the Runtime Helper and observe provider-backed behavior.

### Agent application

```text
package.json
pnpm-lock.yaml
vite.config.ts
server/agents/<name>/agent.ts
src/server.ts or framework route
```

Use the folder form when the Agent owns instructions, a Workspace, or Skills. Add Sources, Capabilities, Channels, Boxes, Schedules, and Workflows only when the outcome needs them.

### Scheduled Agent

```text
server/agents/<name>/agent.ts
server/schedules/<name>.ts
```

The Schedule owns wake timing; orchestration invokes the Agent with explicit input, identity, retry/idempotency, and terminal-state behavior.

### Full-stack application

Keep client framework plugins first, ViteHub composition next, and the host integration last. Client code calls an application route; server code owns Runtime Helpers, Agent Invocations, secrets, and provider bindings.

## Boundary pass

For every shape, state whether persistence is ephemeral or durable, which external authority exists, which host runs the code, how failures retry, and what the user can observe. A local demo may answer “ephemeral, local, no external authority,” but it must answer.

## Proof

The shape is complete when every requested behavior has a source file and runtime path, the build succeeds, and one live request or invocation observes the intended state change.
