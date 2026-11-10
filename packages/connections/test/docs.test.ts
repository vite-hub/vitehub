import { expect, it } from "vitest"

import { defineConnection } from "../src/definition.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"
import { createStore, mailConnection, testProvider } from "./helpers.ts"

it("inspects the definition's docs, else the colocated file, which instances share", async () => {
  const runtime = createConnectionsRuntime({
    definitions: {
      mail: { ...mailConnection(), docs: "Sign in with the **support** inbox." },
      calendar: mailConnection(),
      plain: mailConnection(),
      tenant: defineConnection({
        instances: ["acme", "globex"],
        definition: instance => ({ provider: testProvider(), scopes: [], ...(instance === "globex" ? { docs: "Ask Globex IT first." } : {}) }),
      }),
    },
    docs: { calendar: async () => "Use the shared calendar account.", plain: "  \n", tenant: "Connect as the tenant's automation user." },
    store: createStore(),
  })
  expect((await runtime.inspect("mail")).docs).toBe("Sign in with the **support** inbox.")
  expect((await runtime.inspect("calendar")).docs).toBe("Use the shared calendar account.")
  expect(await runtime.inspect("plain")).not.toHaveProperty("docs")
  expect((await runtime.inspect("tenant:acme")).docs).toBe("Connect as the tenant's automation user.")
  expect((await runtime.inspect("tenant:globex")).docs).toBe("Ask Globex IT first.")
})

it("rejects docs that are not a string", () => {
  expect(() => defineConnection({ ...mailConnection(), docs: 1 as unknown as string })).toThrow()
})
