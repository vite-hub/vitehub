import { H3 } from "h3"
import { beforeEach, expect, test } from "vitest"
import { useDatabase } from "vite-hub/database/drizzle"
import { kv } from "vite-hub/kv"
import { setupViteHubTest } from "vite-hub/test"

import signup from "../server/api/signup.post.ts"

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

test("signup saves the user, counts it, sends the welcome email, and queues the follow-up", async () => {
  const response = await post("ada@example.com")

  expect(response.status).toBe(200)
  const user = await response.json()
  expect(user).toEqual({ email: "ada@example.com", id: 1 })

  const { db, schema } = useDatabase("default")
  expect(await db.select().from(schema.users)).toEqual([{ email: "ada@example.com", id: 1 }])
  expect(await kv.get("signups")).toEqual([undefined, 1])
  expect(hub.emails).toEqual([{ from: "hello@example.com", subject: "Welcome", text: "Thanks for signing up.", to: "ada@example.com" }])
  expect(hub.jobs).toMatchObject([{ options: { delaySeconds: 86_400 }, payload: { userId: 1 }, queue: "welcome" }])
})

test("each test starts with empty storage", async () => {
  const { db, schema } = useDatabase("default")
  expect(await db.select().from(schema.users)).toEqual([])
  expect(await kv.get("signups")).toEqual([undefined, null])
  expect(hub.emails).toEqual([])
  expect(hub.jobs).toEqual([])

  expect((await post("ada@example.com")).status).toBe(200)
  expect((await post("ada@example.com")).status).toBe(500)
})
