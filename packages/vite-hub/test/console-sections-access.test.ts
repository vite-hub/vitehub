import { afterEach, describe, expect, it } from "vitest"

import { consoleStateKey } from "../src/console/internal.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { listConsoleSections } from "../src/console/runtime/server/sections.get.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { requestEvent } from "./console-event.ts"
import { consoleAccess } from "./support/console-access.ts"

afterEach(() => {
  for (const key of [consoleStateKey, Symbol.for("vitehub.console.access")]) {
    Reflect.deleteProperty(globalThis, key)
  }
})

describe("Console section access metadata", () => {
  it("preserves read-only grants", async () => {
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["kv:read", "blob"] }) })
    installConsoleSections("/app", ["kv", "blob", "email"])

    const result = await listConsoleSections(await consoleAccess(requestEvent(new Request("https://app.example/_vitehub/api/sections"))))
    expect(result).toEqual({ readOnly: ["kv"], scoped: true, sections: ["kv", "blob"] })
  })
})
