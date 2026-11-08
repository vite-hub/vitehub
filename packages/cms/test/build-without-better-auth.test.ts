import { fileURLToPath } from "node:url"

import { build } from "vite"
import { describe, expect, it } from "vitest"

import type { Plugin } from "vite"

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url))

// An app without `better-auth` gets a module with no exports in its place, as Vite does for a missing optional peer.
const missingBetterAuth: Plugin = {
  name: "missing-better-auth",
  enforce: "pre",
  resolveId: id => id.startsWith("better-auth") ? `\0missing:${id}` : undefined,
  load: id => id.startsWith("\0missing:") ? "export default {}" : undefined,
}

describe("an app without better-auth", () => {
  it("bundles the cms preset", async () => {
    await expect(build({
      configFile: false,
      logLevel: "silent",
      plugins: [missingBetterAuth],
      build: {
        write: false,
        ssr: entry,
        rolldownOptions: { external: id => !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0") && !id.startsWith("better-auth") },
      },
    })).resolves.toBeDefined()
  })
})
