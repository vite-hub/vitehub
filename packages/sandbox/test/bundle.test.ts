import { describe, expect, it } from "vitest"

import { bundleSandboxDefinition } from "../src/bundle.ts"
import type { SandboxProject } from "../src/project.ts"

describe("bundleSandboxDefinition assets", () => {
  it("keeps project assets used through the Node filesystem API", async () => {
    const project: SandboxProject = {
      digest: "fixture",
      files: {
        "package.json": {
          contents: Buffer.from(JSON.stringify({ private: true, type: "module" })).toString("base64"),
          encoding: "base64",
        },
        "prompt.md": {
          contents: Buffer.from("Project prompt\n").toString("base64"),
          encoding: "base64",
        },
      },
      install: { args: ["install"], command: "pnpm", cwd: "." },
      packagePath: ".",
    }
    const source = [
      "import { readFile } from 'node:fs/promises'",
      "export default { run: async () => await readFile('./prompt.md', 'utf8') }",
      "",
    ].join("\n")

    const bundle = await bundleSandboxDefinition(source, "/fixture/run.sandbox.ts", {
      execution: "definition",
      project,
    })

    expect(bundle.project?.files).toHaveProperty("prompt.md")
    expect(bundle.entry).toBe(".vitehub-sandbox/definition.js")
    expect(bundle.modules[bundle.entry]).toContain('from "node:fs/promises"')
  })
})
