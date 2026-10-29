import { afterEach, expect, it, vi } from "vitest"
import { installConsoleDevelopment } from "../src/console/runtime/server/development.ts"
import { isConsoleDevelopmentRuntime } from "../src/console/runtime/server/request.ts"
import { installConsoleAccess, readConsoleOperationUser, withConsoleAccess } from "../src/console/runtime/server/access.ts"

afterEach(() => {
  installConsoleDevelopment("/test/app", false)
  installConsoleAccess({ mode: "open" })
  vi.unstubAllEnvs()
})

it("keeps production access and operation identity when runtime NODE_ENV says development", async () => {
  const handle = withConsoleAccess(async (_event, access) => ({ user: await readConsoleOperationUser(access) }), { anySection: true })
  const event = () => ({ req: new Request("http://localhost/_vitehub/rpc/__call") })
  vi.stubEnv("NODE_ENV", "development")
  installConsoleDevelopment("/test/app", false)
  installConsoleAccess({ mode: "open" })
  expect(await handle(event())).toEqual({ user: undefined })
  installConsoleAccess({ mode: "local" })
  const denied = await handle(event())
  expect(denied).toBeInstanceOf(Response)
  expect((denied as Response).status).toBe(403)
  installConsoleDevelopment("/test/app", true)
  expect(await handle(event())).toEqual({ user: { id: "local", name: "You" } })
})

it("uses generated build mode even when production output runs with NODE_ENV=development", () => {
  vi.stubEnv("NODE_ENV", "development")
  installConsoleDevelopment("/test/app", false)
  expect(isConsoleDevelopmentRuntime()).toBe(false)
  vi.stubEnv("NODE_ENV", "production")
  installConsoleDevelopment("/test/app", true)
  expect(isConsoleDevelopmentRuntime()).toBe(true)
})
