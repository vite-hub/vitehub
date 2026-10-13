import { expect, it } from "vitest"

import { renderCloudflareEntry } from "../playground/vite/build/vite-e2e.ts"
import { clearActiveCloudflareEnv, createCloudflareRuntimeEvent, getActiveCloudflareBinding, runWithActiveCloudflareEnv, setActiveCloudflareEnv } from "../packages/internal/src/runtime/cloudflare-env.ts"

it.each(["fetch", "queue", "scheduled"] as const)("scopes generated %s bindings on success and failure", async (method) => {
  const entry = renderCloudflareEntry("/app/entry.mjs", {
    rootDir: "/app",
    clientOutDir: "/app/dist/client",
    hosting: "cloudflare",
    queue: { provider: "cloudflare" },
  }, {
    alias: {},
    generatedDir: "/app/generated",
    queueDefinitions: [],
    scheduleDefinitions: [],
    scheduleCrons: new Map(),
    scheduleRegistryFile: "/app/schedule.mjs",
    rateLimitDeclarations: [],
    workflowBindings: [],
    workflowDefinitions: [],
  })
  let fail = false
  const handle = async () => {
    expect(getActiveCloudflareBinding("BUCKET")).toBe("handler")
    await Promise.resolve()
    expect(getActiveCloudflareBinding("BUCKET")).toBe("handler")
    if (fail) throw new Error("handler failed")
  }
  const scope = (_event: unknown, callback: () => unknown) => callback()
  const dependencies = {
    clearActiveCloudflareEnv,
    createCloudflareRuntimeEvent,
    runWithActiveCloudflareEnv,
    setActiveCloudflareEnv,
    runWithQueueRuntimeEvent: scope,
    runWithWorkflowRuntimeEvent: scope,
    appHandler: handle,
    defaultHandler: handle,
    queueConfig: { provider: "cloudflare" },
    queueDefinitionNames: {},
    loadQueueDefinition: async () => ({ options: {}, handler: handle }),
    createQueueJob: () => ({}),
    createCloudflareQueueBatchHandler: (options: { onMessage: (message: unknown, batch: unknown) => Promise<void> }) => async () => await options.onMessage({}, {}),
    __vitehubScheduleRegistry: { task: async () => ({ cron: "* * * * *" }) },
    executeStaticSchedule: handle,
  }
  const worker = new Function(...Object.keys(dependencies), `${entry.slice(entry.indexOf("const worker = {"), entry.indexOf("export default worker"))}\nreturn worker`)(...Object.values(dependencies)) as Record<typeof method, (event: unknown, env: Record<string, unknown>, context: unknown) => Promise<unknown>>

  try {
    for (fail of [false, true]) {
      await runWithActiveCloudflareEnv({ BUCKET: "outer" }, async () => {
        const pending = worker[method]({ cron: "* * * * *", scheduledTime: 0 }, { BUCKET: "handler" }, {})
        expect(getActiveCloudflareBinding("BUCKET")).toBe("outer")
        if (fail) await expect(pending).rejects.toThrow("handler failed")
        else await pending
        expect(getActiveCloudflareBinding("BUCKET")).toBe("outer")
      })
      expect(getActiveCloudflareBinding("BUCKET")).toBeUndefined()
    }
  }
  finally {
    clearActiveCloudflareEnv()
  }
})
