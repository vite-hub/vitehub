import { afterEach, describe, expect, it } from "vitest"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { installConsolePageTool } from "../src/console/runtime/server/page-tool.ts"
import page from "../src/console/runtime/server/page.get.ts"
import session from "../src/console/runtime/server/page-session.ts"

const event = (path: string) => ({ method: "GET", req: new Request(`http://localhost${path}`) })
afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access"))
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.page-tools"))
})

describe("embedded Console access", () => {
  it("allows same-origin production framing only after the Console allows the request", async () => {
    installConsoleAccess({ mode: "open", authorize: async () => false })
    expect((await page(event("/_vitehub?embed=1"))).headers.get("x-frame-options")).toBe("DENY")
    installConsoleAccess({ mode: "open", authorize: async () => true })
    expect((await page(event("/_vitehub"))).headers.get("x-frame-options")).toBe("DENY")
    const allowed = await page(event("/_vitehub?embed=1"))
    expect(allowed.headers.get("x-frame-options")).toBe("SAMEORIGIN")
    expect(allowed.headers.get("content-security-policy")).toContain("frame-ancestors 'self'")
    expect(allowed.headers.get("cache-control")).toBe("no-store")
  })

  it("does not offer Content to a Console user whose sections exclude it", async () => {
    installConsoleSections("/embedded-test", ["content", "kv"])
    installConsolePageTool({})
    installConsoleAccess({ mode: "open", authorize: async () => ({ sections: ["kv"] }) })
    expect(await (await session(event("/_vitehub/page/session"))).json()).toMatchObject({ tools: [{ id: "console" }] })
    installConsoleAccess({ mode: "open", authorize: async () => ({ sections: ["content"] }) })
    expect(await (await session(event("/_vitehub/page/session"))).json()).toMatchObject({ tools: [{ id: "console" }, { id: "content", lazy: true }] })
  })
})
