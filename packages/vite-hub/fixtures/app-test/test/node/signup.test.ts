import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import { H3 } from "h3"
import { useDatabase } from "vite-hub/database"
import { kv } from "vite-hub/kv"
import { setupViteHubTest } from "vite-hub/test"

import me from "../../server/api/me.get.ts"
import signup from "../../server/api/signup.post.ts"
import resetSignups from "../../server/schedules/reset-signups.ts"

// The same app test as ../signup.test.ts, with `node --import vite-hub/test/register --test` in place of Vitest.
const hub = setupViteHubTest()
const app = new H3().post("/api/signup", signup).get("/api/me", me)

beforeEach(async () => {
  await hub.reset()
  hub.setEnv({ MAIL_FROM: "hello@example.com" })
})

test("signup saves the user, sends the welcome email, queues the follow-up, and starts the onboarding", async () => {
  const response = await app.fetch(new Request("http://localhost/api/signup", {
    body: JSON.stringify({ email: "ada@example.com" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }))

  assert.equal(response.status, 200)
  const { db, schema } = useDatabase("default")
  assert.deepEqual(await db.select().from(schema.users), [{ email: "ada@example.com", id: 1 }])
  assert.deepEqual(await kv.get("signups"), [undefined, 1])
  assert.deepEqual(hub.emails.map(({ subject, to }) => ({ subject, to })), [{ subject: "Welcome", to: "ada@example.com" }])
  assert.deepEqual(hub.jobs.map(({ payload, queue }) => ({ payload, queue })), [{ payload: { userId: 1 }, queue: "welcome" }])
  assert.deepEqual(hub.workflows.map(({ payload, workflow }) => ({ payload, workflow })), [{ payload: { userId: 1 }, workflow: "onboarding" }])
})

test("the nightly Schedule resets the counter", async () => {
  await kv.set("signups", 3)

  const run = await hub.runSchedule(resetSignups, { scheduledAt: new Date("2026-11-08T00:00:00Z") })

  assert.equal(run.status, "succeeded")
  assert.deepEqual(await kv.get("signups"), [undefined, null])
})

test("a signed-in user passes requireAuth()", async () => {
  assert.equal((await app.fetch(new Request("http://localhost/api/me"))).status, 401)

  const { headers } = await hub.signIn({ email: "ada@example.com" })
  const response = await app.fetch(new Request("http://localhost/api/me", { headers }))

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { email: "ada@example.com" })
})
