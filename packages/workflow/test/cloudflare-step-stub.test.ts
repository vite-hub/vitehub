import { describe, expect, it } from "vitest"

import type { WorkflowExecutionContext, WorkflowProviderStep } from "../src/types.ts"
import { runCloudflareWorkflow } from "../src/runtime/cloudflare-runner.ts"

type RemoteMethod = (...args: unknown[]) => Promise<unknown>

/**
 * Models the Workers RPC stub that Cloudflare passes as `step`. Every property is a remote
 * method, and so is every property of that method (`step.sleep.bind` is a remote call).
 * A stub that is sent as an argument moves to the callee, so the local stub is disposed.
 */
function createRpcStepStub(methods: Record<string, RemoteMethod>) {
  const calls: string[] = []
  let disposed = false
  let stub: WorkflowProviderStep

  const remote = (path: string[]): RemoteMethod => new Proxy(async () => undefined, {
    apply(_target, _thisArg, args: unknown[]) {
      if (disposed) throw new Error("RPC stub used after being disposed.")
      if (args.includes(stub)) disposed = true
      calls.push(path.join("."))
      const method = path.length === 1 ? methods[path[0]!] : undefined
      return method ? method(...args) : Promise.resolve(undefined)
    },
    get(_target, property) {
      return typeof property === "string" ? remote([...path, property]) : undefined
    },
  })

  stub = new Proxy({}, {
    get(_target, property) {
      return typeof property === "string" ? remote([property]) : undefined
    },
  })
  return { calls, stub }
}

describe("Cloudflare Workflow step stub", () => {
  it("keeps the step stub usable for step.do, step.sleep, and step.sleepUntil", async () => {
    const { calls, stub } = createRpcStepStub({
      do: async (_name, _options, run) => await (run as () => Promise<unknown>)(),
      sleep: async () => undefined,
      sleepUntil: async () => undefined,
    })

    const result = await runCloudflareWorkflow({
      config: { driver: "cloudflare" },
      env: {},
      event: { instanceId: "run-1", payload: { name: "ada" } },
      name: "nap",
      registry: {
        nap: async () => ({
          default: {
            rootStep: false,
            handler: async (context: Pick<WorkflowExecutionContext<{ name: string }>, "payload" | "sleep"> & { step?: WorkflowProviderStep }) => {
              const greeting = await context.step!.do!("greet", {}, () => `hello ${context.payload.name}`)
              await context.sleep("1 second")
              await context.sleep(new Date(0))
              return greeting
            },
          },
        }),
      },
      step: stub,
    })

    expect(calls).toEqual(["do", "sleep", "sleepUntil"])
    expect(result).toBe("hello ada")
  })
})
