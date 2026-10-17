import { describe, expect, it, vi } from "vitest"

import { github } from "../src/channels.ts"
import { defineCapability } from "../src/capability-runtime.ts"
import { defineAgent, runAgentInline, streamAgent } from "../src/index.ts"
import { forgeAccessKey, readForgeAccess } from "../src/internal/forge-access.ts"
import type { AgentCallbackContext, AgentRuntimeContext } from "../src/types.ts"

function runtime(): AgentRuntimeContext {
  return {
    memo: (_key, create) => create(),
    runtime: "unknown",
    waitUntil: promise => void Promise.resolve(promise).catch(() => {}),
  }
}

function tokenSource(token = "installation-token") {
  return vi.fn(async (_context: unknown, _scope: { repository?: string, signal?: AbortSignal }) => token)
}

async function resolve(context: unknown, repository = "acme/app"): Promise<string | undefined> {
  // SAFETY: the Driver run context is the Agent runtime context, an object.
  const access = readForgeAccess(context as object)
  // SAFETY: the test token sources do not read the callback context.
  return await access?.(runtime() as AgentCallbackContext, { repository })
}

describe("Agent forge access", () => {
  it("gives the Invocation the forge access of a github() Channel App", async () => {
    const token = tokenSource()
    const agent = defineAgent({
      channels: { github: github({ app: { token } }) },
      driver: { run: context => resolve(context) },
      runtime: false,
    })

    expect(await runAgentInline(agent, runtime(), {})).toBe("installation-token")
    expect(token).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ repository: "acme/app" }))
  })

  it("gives streamed runs the forge access", async () => {
    const seen: unknown[] = []
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "forge-access-probe",
        resolve(context) {
          seen.push(readForgeAccess(context.runtimeContext))
        },
      })],
      channels: { github: github({ app: { token: tokenSource() } }) },
      driver: {
        run: (context) => {
          seen.push(readForgeAccess(context))
          return (async function* () {
            yield "done"
          })()
        },
      },
      runtime: false,
    })

    // SAFETY: streamAgent returns an async iterable for a driver that yields text.
    const stream = await streamAgent(agent, runtime(), {}) as AsyncIterable<unknown>
    for await (const _event of stream) { /* consume the stream */ }

    expect(seen).toHaveLength(2)
    expect(seen[0]).toBeTypeOf("function")
    expect(seen[1]).toBe(seen[0])
  })

  it("keeps forge access that the caller already supplied", async () => {
    const caller = vi.fn(async () => "caller-token")
    const agent = defineAgent({
      channels: { github: github({ app: { token: tokenSource() } }) },
      driver: { run: context => resolve(context) },
      runtime: false,
    })

    const context = { ...runtime(), [forgeAccessKey]: caller }
    expect(await runAgentInline(agent, context, {})).toBe("caller-token")
  })

  it("keeps the forge access through extends", async () => {
    const parent = defineAgent({
      channels: { github: github({ app: { token: tokenSource() } }) },
      driver: { run: context => resolve(context) },
      runtime: false,
    })
    const child = defineAgent({ extends: parent, description: "child" })

    expect(await runAgentInline(child, runtime(), {})).toBe("installation-token")
  })

  it("has no forge access without a github() Channel App", async () => {
    const agent = defineAgent({
      channels: { github: github() },
      driver: { run: context => readForgeAccess(context) },
      runtime: false,
    })

    expect(readForgeAccess(github())).toBeUndefined()
    expect(await runAgentInline(agent, runtime(), {})).toBeUndefined()
  })

  it("has no forge access when two github() Channel Apps disagree", async () => {
    const agent = defineAgent({
      channels: {
        first: github({ app: { token: tokenSource("first") } }),
        second: github({ app: { token: tokenSource("second") } }),
      },
      driver: { run: context => readForgeAccess(context) },
      runtime: false,
    })

    expect(await runAgentInline(agent, runtime(), {})).toBeUndefined()
  })
})
