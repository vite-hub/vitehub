import { describe, expect, it } from "vitest"
import { createRequire } from "node:module"
import { ShellLanding } from "../app/data/primitive-landings/shell"
import { createShellRuntime } from "../../packages/shell/src/index.ts"
import { createJustBashProvider } from "../../packages/shell/src/providers/just-bash.ts"

const { InMemoryFs } = createRequire(new URL("../../packages/shell/package.json", import.meta.url))("just-bash")

describe("Shell landing starter projects", () => {
  for (const variant of ShellLanding.variants) {
    it(`runs the ${variant.label} example`, async () => {
      const source = variant.files.find(file => file.path === "shell.ts")!.content
      const imports = [
        'import { createShellRuntime } from "vite-hub/shell";',
        'import { createJustBashProvider } from "vite-hub/shell/providers/just-bash";',
        'import { InMemoryFs } from "just-bash";',
      ]
      let executable = source
      for (const statement of imports) {
        expect(source).toContain(statement)
        executable = executable.replace(statement, "")
      }
      const run = new Function("createShellRuntime", "createJustBashProvider", "InMemoryFs", "console",
        `return (async () => { ${executable}\nreturn observation; })()`)
      const observation = await run(createShellRuntime, createJustBashProvider, InMemoryFs, { log() {} })
      expect(observation.exitCode).toBe(0)
      expect(observation.stdout).toBe("Hello from Shell!\n")
      expect(observation.stderr).toBe("")
      const manifest = JSON.parse(variant.files.find(file => file.path === "package.json")!.content)
      expect(manifest.dependencies).toHaveProperty("vite-hub")
      expect(manifest.dependencies).toHaveProperty("just-bash")
      expect(manifest.scripts.start).toBe("node shell.ts")
    })
  }
})
