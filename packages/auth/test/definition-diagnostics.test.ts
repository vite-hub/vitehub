import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { expect, it } from "vitest"

it("reports incomplete runtime secondary storage in object Auth Definitions", () => {
  const cache = resolve(import.meta.dirname, "../node_modules/.cache")
  mkdirSync(cache, { recursive: true })
  const root = mkdtempSync(join(cache, "auth-definition-"))
  try {
    writeFileSync(join(root, "input.ts"), `import { defineAuth } from "@vite-hub/auth"
defineAuth({
  emailAndPassword: { enabled: true },
  runtime: { secondaryStorage: { get: () => null, set: () => {}, delete: () => {} } },
})
`)
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "ESNext",
        types: [],
      },
      files: ["input.ts"],
    }))
    const compiler = resolve(import.meta.dirname, "../../../test/package-typecheck.mjs")
    const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.json", "--pretty", "false"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
    })
    const output = result.stdout + result.stderr
    expect(result.error).toBeUndefined()
    expect(result.status, output).toBe(2)
    expect(output).toContain("input.ts(4,14): error TS2769")
    expect(output).toContain("type 'SecondaryStorage'")
    expect(output).toContain("getAndDelete")
    expect(output).toContain("increment")
    expect(output).not.toContain("'emailAndPassword' does not exist")
  }
  finally {
    rmSync(root, { force: true, recursive: true })
  }
})
