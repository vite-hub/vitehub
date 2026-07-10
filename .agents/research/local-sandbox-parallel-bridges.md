# Parallel local harness bridge ports

## Decision

The local harness sandbox should use an OS-assigned bridge port by default: expose `ports: [0]` on each default session and omit provider-level `bridgePorts` unless the caller explicitly supplies a fixed port pool. This is the smallest ownership seam because `createLocalHarnessSandbox()` owns both the host process spawning and the session's network metadata; Claude Code and Codex consume that metadata without needing ViteHub-specific changes. (`packages/agent/src/harness/local-sandbox.ts:94-137,144-225`; `packages/agent/src/harness/claude-code.ts:23-45`; `packages/agent/src/harness/codex.ts:25-75`)

Expected behavior:

- Concurrent default local sessions, including sessions created by different provider instances or processes, bind different host ports without coordination. Node assigns an arbitrary unused port when a server listens on port `0`, and the first-party harness bridge reports the actual bound port after the `listening` event. ([Node `server.listen()`](https://nodejs.org/api/net.html#serverlistenport-host-backlog-callback); [AI SDK bridge source](https://github.com/vercel/ai/blob/main/packages/harness/src/bridge/index.ts#L189-L195), [binding and ready event](https://github.com/vercel/ai/blob/main/packages/harness/src/bridge/index.ts#L569-L616))
- Explicit `ports` remain an opt-in, pre-reserved fixed pool. The harness may lease one pool member per concurrent session, so fixed-pool concurrency is bounded by the number of ports supplied. ([sandbox provider contract](https://github.com/vercel/ai/blob/main/packages/harness/src/v1/harness-v1-sandbox-provider.ts#L14-L24); [lease implementation](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/internal/bridge-port-registry.ts#L20-L42))
- `getPortUrl()` continues to receive the actual bound port, not the sentinel `0`, because both bridge-backed adapters wait for `bridge-ready` and resolve the URL with its reported `boundPort`. ([Claude Code adapter](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts#L551-L670); [Codex adapter](https://github.com/vercel/ai/blob/main/packages/harness-codex/src/codex-harness.ts#L312-L413))

## Evidence

### The collision is owned by the local provider

The current local provider gives each session an isolated temporary filesystem root, but `spawn()` launches an ordinary host child process. Every default session therefore shares the host TCP namespace even though its files live under a separate root. (`packages/agent/src/harness/local-sandbox.ts:28-35,94-106,144-155`)

Before this fix, both the session and provider advertised `[4000]`. Every bridge-backed session consequently tried to bind the same host address, and Node defines `EADDRINUSE` as another server already listening on the requested port. (`packages/agent/src/harness/local-sandbox.ts` at parent commit `ff8e0b4e4d24f58a622e190c426c4d24eaf7d177`, lines 144-155 and 217-225; [Node `server.listen()` error semantics](https://nodejs.org/api/net.html#serverlisten))

The existing local-sandbox test only asserted that a session mapped port `4000` to `ws://127.0.0.1:4000`; it did not start two listeners or exercise provider-instance concurrency. (`packages/agent/test/local-sandbox.test.ts` at parent commit `ff8e0b4e4d24f58a622e190c426c4d24eaf7d177`, lines 9-26)

### The AI SDK contract supports the dynamic default

`HarnessV1SandboxProvider.bridgePorts` is specifically a pool of caller-reserved ports for a wrapped sandbox. The contract says create-new providers should leave it undefined; the process-wide registry is keyed by provider object, and its own source says different provider instances have independent registries and cross-process coordination is outside its scope. ([provider contract](https://github.com/vercel/ai/blob/main/packages/harness/src/v1/harness-v1-sandbox-provider.ts#L14-L24); [registry scope](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/internal/bridge-port-registry.ts#L1-L18))

Claude Code and Codex default to the first entry in `sandboxSession.ports`. Claude Code passes that value through `BRIDGE_WS_PORT`, waits for the bridge's actual `boundPort`, and then calls `getPortUrl({ port: boundPort })`; the Codex adapter follows the same sequence. ([Claude Code port contract](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts#L67-L72), [Claude Code startup](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts#L551-L670), [Claude Code resolution](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts#L681-L692); [Codex port contract and startup](https://github.com/vercel/ai/blob/main/packages/harness-codex/src/codex-harness.ts#L78-L85), [Codex binding flow](https://github.com/vercel/ai/blob/main/packages/harness-codex/src/codex-harness.ts#L312-L435))

The shared bridge explicitly documents `0` as OS-assigned, uses `BRIDGE_WS_PORT` with a default of `0`, binds its WebSocket server with that value, then obtains and publishes the actual port from `wss.address()`. ([bridge option and resolution](https://github.com/vercel/ai/blob/main/packages/harness/src/bridge/index.ts#L133-L147), [bridge environment fallback](https://github.com/vercel/ai/blob/main/packages/harness/src/bridge/index.ts#L189-L195), [bridge binding and ready event](https://github.com/vercel/ai/blob/main/packages/harness/src/bridge/index.ts#L569-L616))

A local runtime check against the installed `@ai-sdk/harness@1.0.0` started two concurrent `runBridge({ port: 0 })` instances. They reported distinct bound ports (`62013` and `62014`) and both closed cleanly. The installed version is pinned by `pnpm-workspace.yaml:8-11` and `pnpm-lock.yaml:1222-1233`.

## Rejected alternatives

- Do not serialize local invocations. That would turn an implementation collision into a product concurrency limit even though the bridge and operating system already support independent listeners. ([Node port-0 semantics](https://nodejs.org/api/net.html#serverlistenport-host-backlog-callback); [AI SDK bridge ready event](https://github.com/vercel/ai/blob/main/packages/harness/src/bridge/index.ts#L604-L616))
- Do not scan for a free fixed port and close a probe socket before starting the bridge. Port `0` lets the operating system select the port during the bridge's actual bind, avoiding a reservation gap; Node exposes the selected port after `listening`, which is exactly the protocol the harness bridge already implements. ([Node port-0 semantics](https://nodejs.org/api/net.html#serverlistenport-host-backlog-callback); [AI SDK bridge binding](https://github.com/vercel/ai/blob/main/packages/harness/src/bridge/index.ts#L569-L616))
- Do not change the Claude Code or Codex adapters. Their existing contract already propagates an OS-assigned port correctly from sandbox metadata through `bridge-ready` to `getPortUrl()`. ([Claude Code startup](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts#L551-L670); [Codex startup](https://github.com/vercel/ai/blob/main/packages/harness-codex/src/codex-harness.ts#L312-L413))

## Regression proof

The focused ViteHub regression should assert that default sessions advertise `ports: [0]`, the default provider has no `bridgePorts` pool, and two default local provider instances can hold simultaneous listeners with distinct actual addresses. A separate assertion should preserve explicit fixed-pool metadata. These checks target the ownership seam and the failure mode without starting a real authenticated Claude Code or Codex run. (`packages/agent/test/local-sandbox.test.ts:22-73`; `packages/agent/src/harness/local-sandbox.ts:144-225`)
