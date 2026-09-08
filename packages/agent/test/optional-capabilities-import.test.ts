import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { expect, it } from "vitest"

const execFileAsync = promisify(execFile)

it("imports general Capabilities without optional telemetry packages", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", `
    import { registerHooks } from "node:module"
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (/^(evlog|posthog-node)(\\/|$)/.test(specifier)) {
        throw new Error("Optional telemetry must not load: " + specifier)
      }
      return nextResolve(specifier, context)
    } })
    const capabilities = await import("@vite-hub/agent/capabilities")
    if (typeof capabilities.access !== "function" || typeof capabilities.fetch !== "function") {
      throw new Error("Missing general Capabilities")
    }
    console.log("capabilities imported")
  `], { cwd: new URL("..", import.meta.url) })

  expect(stdout.trim()).toBe("capabilities imported")
})
