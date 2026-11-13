import { H3 } from "h3"
import { beforeEach, expect, test } from "vitest"
import { useDatabase } from "vite-hub/database"
import { kv } from "vite-hub/kv"
import { dynamicQueue } from "vite-hub/queue"
import { setupViteHubTest } from "vite-hub/test"
import { startWorkflow } from "vite-hub/workflow"

import signup from "../server/api/signup.post.ts"
import resetSignups from "../server/schedules/reset-signups.ts"

const hub = setupViteHubTest()
const app = new H3().post("/api/signup", signup)

beforeEach(async () => {
  await hub.reset()
  hub.setEnv({ MAIL_FROM: "hello@example.com" })
})

function post(email: string) {
  return app.fetch(new Request("http://localhost/api/signup", {
    body: JSON.stringify({ email }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }))
}

test("signup saves the user, counts it, sends the welcome email, queues the follow-up, and starts the onboarding", async () => {
  const response = await post("ada@example.com")

  expect(response.status).toBe(200)
  const user = await response.json()
  expect(user).toEqual({ email: "ada@example.com", id: 1 })

  const { db, schema } = useDatabase("default")
  expect(await db.select().from(schema.users)).toEqual([{ email: "ada@example.com", id: 1 }])
  expect(await kv.get("signups")).toEqual([undefined, 1])
  expect(hub.emails).toEqual([{ from: "hello@example.com", subject: "Welcome", text: "Thanks for signing up.", to: "ada@example.com" }])
  expect(hub.jobs).toMatchObject([{ options: { delaySeconds: 86_400 }, payload: { userId: 1 }, queue: "welcome" }])
  expect(hub.workflows).toMatchObject([{ payload: { userId: 1 }, status: "queued", workflow: "onboarding" }])
})

test("each test starts with empty storage", async () => {
  const { db, schema } = useDatabase("default")
  expect(await db.select().from(schema.users)).toEqual([])
  expect(await kv.get("signups")).toEqual([undefined, null])
  expect(hub.emails).toEqual([])
  expect(hub.jobs).toEqual([])
  expect(hub.workflows).toEqual([])

  expect((await post("ada@example.com")).status).toBe(200)
  expect((await post("ada@example.com")).status).toBe(500)
})

test("keeps configured provider rules and Definition lookup in app tests", async () => {
  await expect(dynamicQueue.send("misspelled", {})).rejects.toMatchObject({ code: "QUEUE_DEFINITION_NOT_FOUND" })
  await expect(startWorkflow("misspelled", {})).rejects.toMatchObject({ code: "WORKFLOW_DEFINITION_NOT_FOUND" })
  expect(await dynamicQueue.send("welcome", { userId: 1 }, { contentType: "json" })).toMatchObject([{ code: "QUEUE_UNSUPPORTED_OPTION" }, undefined])
  expect(hub.jobs).toEqual([])
  expect(await startWorkflow("onboarding", { userId: 1 })).toMatchObject({ provider: "vercel", status: "queued" })
})

test("the nightly Schedule resets the counter", async () => {
  expect((await post("ada@example.com")).status).toBe(200)

  const run = await hub.runSchedule(resetSignups, { scheduledAt: new Date("2026-11-08T00:00:00Z") })

  expect(run.status).toBe("succeeded")
  expect(await kv.get("signups")).toEqual([undefined, null])
  expect(await kv.get("last-reset")).toEqual([undefined, "2026-11-08T00:00:00.000Z"])
})
