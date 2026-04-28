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

const create = await fetch(new URL("/api/db", base), {
  method: "POST",
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify({ title: `db-e2e-${Date.now().toString(36)}` }),
})

assert.equal(create.status, 200)
const created = await create.json() as { note?: { id?: number, title?: string }, ok?: boolean }
assert.equal(created.ok, true)
assert.equal(typeof created.note?.id, "number")

const list = await fetch(new URL("/api/db", base))
assert.equal(list.status, 200)
const payload = await list.json() as { notes?: Array<{ id: number, title: string }>, ok?: boolean }
assert.equal(payload.ok, true)
assert.ok(payload.notes?.some(note => note.id === created.note?.id))

console.log(JSON.stringify({ ok: true, total: payload.notes?.length || 0 }))
