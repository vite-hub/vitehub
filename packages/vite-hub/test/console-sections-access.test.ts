import { afterEach, describe, expect, it } from "vitest"

import { consoleAuthKey, consoleSectionsKey, consoleSectionsRegistryKey, consoleSectionsRootKey } from "../src/console/internal.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import sectionsHandler from "../src/console/runtime/server/sections.get.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"

afterEach(() => {
  for (const key of [consoleAuthKey, consoleSectionsKey, consoleSectionsRegistryKey, consoleSectionsRootKey, Symbol.for("vitehub.console.access")]) {
    Reflect.deleteProperty(globalThis, key)
    Reflect.deleteProperty(process, key)
  }
})

describe("Console section access metadata", () => {
  it.each([
    { mode: "auth" as const, independentAuth: false, auth: true },
    { mode: "open" as const, independentAuth: true, auth: true },
    { mode: "open" as const, independentAuth: false, auth: false },
  ])("preserves read-only grants with $mode access and independent Auth $independentAuth", async ({ mode, independentAuth, auth }) => {
    const authorize = () => ({ sections: ["kv:read", "blob"] })
    installConsoleAccess(mode === "auth" ? { mode, authorize, check: async () => undefined } : { mode, authorize })
    installConsoleSections("/app", ["kv", "blob", "email"], independentAuth)

    const result = await sectionsHandler({ req: new Request("https://app.example/api/_vitehub/console/sections") })
    expect(result).toMatchObject({ readOnly: ["kv"], scoped: true, sections: ["kv", "blob"] })
    if (auth) expect(result).toHaveProperty("auth", true)
    else expect(result).not.toHaveProperty("auth")
  })
})
