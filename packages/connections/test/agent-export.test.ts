import { createRequire } from "node:module"

import { expect, it } from "vitest"

import { connections } from "../dist/agent.js"

it("publishes the Agent primitive entry used by generated routes", async () => {
  const require = createRequire(import.meta.url)
  expect(require.resolve("@vite-hub/connections/agent")).toContain("/dist/agent.js")
  expect(typeof connections.runtime).toBe("function")
})
