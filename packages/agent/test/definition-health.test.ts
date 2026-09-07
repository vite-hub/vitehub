import { describe, expect, it } from "vitest"
import { createAgentHealthHandler, resolveAgentHealth } from "../src/health.ts"
import { defineAgent } from "../src/index.ts"

describe("definition health", () => {
  it("returns the GET headers and status without a body for HEAD", async () => {
    const agent = defineAgent({ driver: { run: () => "ok" }, runtime: false })
    const handle = createAgentHealthHandler(agent)
    const get = await handle(new Request("http://localhost/health"))
    const head = await handle(new Request("http://localhost/health", { method: "HEAD" }))
    expect(head.status).toBe(get.status)
    expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"))
    expect(await head.text()).toBe("")
    expect(await get.json()).toMatchObject({ ok: true })
  })

  it("accepts public definitions without private settings", async () => {
    const publicDefinition = { ...defineAgent({ name: "public", driver: { run: () => "ok" }, runtime: false }) }
    expect(await resolveAgentHealth(publicDefinition)).toMatchObject({
      ok: true,
      agent: { name: "public" },
      checks: { driver: { status: "unsupported" } },
    })
  })
})
