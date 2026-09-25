import { describe, expect, it } from "vitest"

import {
  installConsoleProjectNameScope,
  installConsoleSectionScope,
  resolveConsoleAuth,
  type ConsoleInvocationScope,
} from "../src/console/internal.ts"

describe("Console auth root scope", () => {
  it.each([false, true])(
    "keeps independent auth scoped to its own realm (independent first: %s)",
    (independentFirst) => {
      const process = {}
      const independent: ConsoleInvocationScope = { process }
      const hostManaged: ConsoleInvocationScope = { process }
      const registrations = [
        () => installConsoleSectionScope("/independent", ["agents"], independent, true),
        () => installConsoleSectionScope("/host-managed", ["agents"], hostManaged, false),
      ]
      if (!independentFirst) registrations.reverse()
      for (const register of registrations) register()

      expect(resolveConsoleAuth(independent)).toBe(true)
      expect(resolveConsoleAuth(hostManaged)).toBe(false)
    },
  )

  it("does not trust the last root when multiple projects share a scope", () => {
    const scope: ConsoleInvocationScope = { process: {} }
    installConsoleSectionScope("/host-managed", ["agents"], scope, false)
    installConsoleProjectNameScope("/independent", "Independent", scope)
    installConsoleSectionScope("/independent", ["agents"], scope, true)

    expect(resolveConsoleAuth(scope)).toBe(false)
  })

  it("does not trust an unbound scope's last auth value with multiple registered roots", () => {
    const process = {}
    installConsoleSectionScope("/host-managed", ["agents"], { process }, false)
    installConsoleSectionScope("/independent", ["agents"], { process }, true)

    expect(resolveConsoleAuth({ process })).toBe(false)
  })
})
