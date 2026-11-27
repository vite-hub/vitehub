import { createRequire } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { expectJson, nitroWorkerUnavailable, type PrimitiveRow } from "./row.ts"

async function eventually(check: () => Promise<void>, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (true) {
    try {
      return await check()
    }
    catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
}

interface RealtimeClient {
  connectRealtimeRoom: (definition: string, id: string, options: { origin: string }) => {
    onRequest: (handler: (body: unknown) => unknown) => void
    status: () => string
    destroy: () => void
  }
}

export const jobs: PrimitiveRow[] = [
  {
    id: "queue",
    packages: ["@vite-hub/kv", "@vite-hub/queue"],
    vitehub: () => ({ kv: true, queue: true }),
    files: {
      "server/queues/primitive-job.ts": `
        import { kv } from "vite-hub/kv"
        import { defineQueue } from "vite-hub/queue"

        export default defineQueue<{ key: string }>({
          handler: async ({ payload }) => {
            const [error] = await kv.set(\`primitives:queue:\${payload.key}\`, "consumed")
            if (error) throw error
          },
        })
      `,
      "server/api/primitives/queue.ts": `
        import { defineEventHandler, getQuery } from "nitro/h3"
        import { kv } from "vite-hub/kv"
        import { sendQueue } from "vite-hub/queue"

        export default defineEventHandler(async (event) => {
          const key = String(getQuery(event).key)
          if (event.req.method === "POST") {
            const [error, result] = await sendQueue("primitive-job", { key })
            if (error) throw error
            return { status: result.status }
          }
          const [error, value] = await kv.get(\`primitives:queue:\${key}\`)
          if (error) throw error
          return { value: value ?? null }
        })
      `,
    },
    async probe({ fetch, mode }) {
      const key = `${mode}-${crypto.randomUUID()}`
      await expectJson(await fetch(`/api/primitives/queue?key=${key}`, { method: "POST" }), { status: "queued" })
      await eventually(async () => expectJson(await fetch(`/api/primitives/queue?key=${key}`), { value: "consumed" }))
    },
  },
  {
    id: "schedule",
    packages: ["@vite-hub/kv", "@vite-hub/schedule"],
    vitehub: () => ({ kv: true }),
    files: {
      "server/schedules/primitive-report.ts": `
        import { kv } from "vite-hub/kv"
        import { defineSchedule } from "vite-hub/schedule"

        export default defineSchedule({
          cron: "0 3 1 1 *",
          manual: true,
          async handler({ scheduledAt }) {
            const [error] = await kv.set(\`primitives:schedule:\${scheduledAt.toISOString()}\`, "ran")
            if (error) throw error
          },
        })
      `,
      "server/api/primitives/schedule.post.ts": `
        import { defineEventHandler, getQuery } from "nitro/h3"
        import { kv } from "vite-hub/kv"
        import { runSchedule } from "vite-hub/schedule"

        export default defineEventHandler(async (event) => {
          const scheduledAt = String(getQuery(event).at)
          const [error, run] = await runSchedule("primitive-report", { scheduledAt })
          if (error) throw error
          const [readError, value] = await kv.get(\`primitives:schedule:\${scheduledAt}\`)
          if (readError) throw readError
          return { status: run.status, value: value ?? null }
        })
      `,
    },
    async probe({ fetch }) {
      const at = new Date(Date.UTC(2000 + Math.floor(Math.random() * 1000), 0, 1, 3)).toISOString()
      await expectJson(await fetch(`/api/primitives/schedule?at=${at}`, { method: "POST" }), { status: "succeeded", value: "ran" })
    },
  },
  {
    id: "workflow",
    packages: ["@vite-hub/workflow"],
    vitehub: () => ({ workflow: true }),
    files: {
      "server/workflows/primitive-sum/index.ts": `
        import { defineWorkflow } from "vite-hub/workflow"

        export default defineWorkflow<{ values: number[] }>({
          handler: async ({ payload, steps }) => ({ sum: await steps.add(payload.values) }),
        })
      `,
      "server/workflows/primitive-sum/01.add.ts": `
        export default async function add(values: number[]) {
          return values.reduce((sum, value) => sum + value, 0)
        }
      `,
      "server/api/primitives/workflow.ts": `
        import { defineEventHandler, getQuery } from "nitro/h3"
        import { getWorkflowRun, startWorkflow } from "vite-hub/workflow"

        export default defineEventHandler(async (event) => {
          const query = getQuery(event)
          if (event.req.method === "POST") {
            const [error, run] = await startWorkflow("primitive-sum", { values: String(query.values).split(",").map(Number) })
            if (error) throw error
            return { id: run.id }
          }
          const [error, run] = await getWorkflowRun("primitive-sum", String(query.id))
          if (error) throw error
          return { status: run.status, result: run.result ?? null }
        })
      `,
    },
    async probe({ fetch }) {
      const started = await fetch("/api/primitives/workflow?values=2,3,37", { method: "POST" })
      const body = await started.text()
      if (!started.ok) throw new Error(`${started.url} answered ${started.status}: ${body.slice(0, 2000)}`)
      const { id } = JSON.parse(body) as { id: string }
      await eventually(async () => expectJson(await fetch(`/api/primitives/workflow?id=${encodeURIComponent(id)}`), { status: "completed", result: { sum: 42 } }))
    },
  },
  {
    id: "sandbox",
    packages: ["@vite-hub/sandbox"],
    dependencies: { "@cloudflare/sandbox": "1.0.3", "@vercel/sandbox": "4.0.0", typescript: "6.0.3" },
    vitehub: target => ({ sandboxTask: target === "cloudflare" ? true : { driver: "vercel" } }),
    files: {
      "server/sandbox-tasks/primitive-sum/package.json": `${JSON.stringify({ private: true, type: "module", vitehub: { sandboxTask: { timeout: 60_000 } } }, null, 2)}\n`,
      "server/sandbox-tasks/primitive-sum/index.ts": `
        export default async function primitiveSum(payload: { values: number[] }) {
          return { sum: payload.values.reduce((sum, value) => sum + value, 0), node: process.version.startsWith("v") }
        }
      `,
      "server/api/primitives/sandbox.post.ts": `
        import { defineEventHandler, getQuery } from "nitro/h3"
        import { runSandboxTask } from "vite-hub/sandbox/task"

        export default defineEventHandler(async (event) => {
          const values = String(getQuery(event).values).split(",").map(Number)
          const [error, result] = await runSandboxTask("primitive-sum", { values })
          if (error) throw error
          return result
        })
      `,
    },
    async probe({ fetch }) {
      await expectJson(await fetch("/api/primitives/sandbox?values=2,3,37", { method: "POST" }), { sum: 42, node: true })
    },
    exempt: {
      "node-build": "The Vercel Sandbox driver needs credentials in a Node production build, which this local check does not have.",
      "cloudflare-build": "`wrangler dev` does not start the Sandbox Container on a local machine: workerd logs `kj/timer.c++:30: overloaded: operation timed out` and then `exec() cannot be called on a container that is not running`, with rootless Docker and with rootful Docker 29. The repository's local e2e also treats Sandbox as live-only, and the `Sandbox Task Live E2E` job in live-smoke.yml runs it on Cloudflare.",
    },
  },
  {
    id: "realtime",
    packages: ["@vite-hub/realtime"],
    files: {
      "server/realtime/primitive-tabs.ts": `
        import { defineRealtime } from "vite-hub/realtime"

        export default defineRealtime({ access: "public", document: false, requests: true })
      `,
      "server/api/primitives/realtime.post.ts": `
        import { defineEventHandler, getQuery } from "nitro/h3"
        import { requestRealtimeRoom } from "vite-hub/realtime/server"

        export default defineEventHandler(async (event) => {
          const room = String(getQuery(event).room)
          const [error, answer] = await requestRealtimeRoom("primitive-tabs", room, { question: "title" })
          if (error) throw error
          return { answer }
        })
      `,
    },
    async probe({ appDir, fetch, mode, origin }) {
      const resolve = createRequire(join(appDir, "package.json")).resolve
      const client = await import(pathToFileURL(resolve("@vite-hub/realtime/client/browser.js")).href) as RealtimeClient
      const deadline = Date.now() + 30_000
      for (;;) {
        const room = `${mode}-${crypto.randomUUID()}`
        const tab = client.connectRealtimeRoom("primitive-tabs", room, { origin })
        tab.onRequest(body => ({ asked: body, title: `tab ${room}` }))
        try {
          await eventually(async () => {
            if (tab.status() !== "connected") throw new Error(`The Realtime room is ${tab.status()}.`)
          }, Math.max(0, deadline - Date.now()))
          const response = await fetch(`/api/primitives/realtime?room=${room}`, { method: "POST" })
          if (!nitroWorkerUnavailable(mode, response) || Date.now() >= deadline) {
            await expectJson(response, { answer: { asked: { question: "title" }, title: `tab ${room}` } })
            return
          }
          await response.body?.cancel()
        }
        finally {
          tab.destroy()
        }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    },
  },
]
