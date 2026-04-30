import { parseArgs } from "node:util"
import assert from "node:assert/strict"

const { values } = parseArgs({
  options: {
    url: { type: "string" },
  },
  strict: true,
})

assert.ok(values.url, "--url required")

const base = new URL(String(values.url))

async function assertStatus(response: Response, expected: number) {
  if (response.status === expected) {
    return
  }

  const body = await response.text()
  assert.fail(`Expected status ${expected}, got ${response.status}. Body: ${body}`)
}

const create = await fetch(new URL("/api/db", base), {
  method: "POST",
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify({ title: `db-e2e-${Date.now().toString(36)}` }),
})

await assertStatus(create, 200)
const created = await create.json() as { note?: { id?: number, title?: string }, ok?: boolean }
assert.equal(created.ok, true)
assert.equal(typeof created.note?.id, "number")

const list = await fetch(new URL("/api/db", base))
await assertStatus(list, 200)
const payload = await list.json() as { notes?: Array<{ id: number, title: string }>, ok?: boolean }
assert.equal(payload.ok, true)
assert.ok(payload.notes?.some(note => note.id === created.note?.id))

const createAnalyticsEvent = await fetch(new URL("/api/db/analytics", base), {
  method: "POST",
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify({ name: `analytics-e2e-${Date.now().toString(36)}` }),
})

await assertStatus(createAnalyticsEvent, 200)
const createdAnalyticsEvent = await createAnalyticsEvent.json() as { event?: { id?: number, name?: string }, ok?: boolean }
assert.equal(createdAnalyticsEvent.ok, true)
assert.equal(typeof createdAnalyticsEvent.event?.id, "number")

const analyticsList = await fetch(new URL("/api/db/analytics", base))
await assertStatus(analyticsList, 200)
const analyticsPayload = await analyticsList.json() as { events?: Array<{ id: number, name: string }>, ok?: boolean }
assert.equal(analyticsPayload.ok, true)
assert.ok(analyticsPayload.events?.some(event => event.id === createdAnalyticsEvent.event?.id))

console.log(JSON.stringify({
  analyticsTotal: analyticsPayload.events?.length || 0,
  ok: true,
  total: payload.notes?.length || 0,
}))
