import { describe, expect, it } from "vitest"

import { bundleSandboxDefinition } from "../src/bundle.ts"
import type { SandboxProject } from "../src/project.ts"

describe("bundleSandboxDefinition assets", () => {
  it("omits project files when filesystem APIs only access runtime paths", async () => {
    const project: SandboxProject = {
      digest: "strata-fixture",
      files: Object.fromEntries(Array.from({ length: 179 }, (_, index) => [
        `unrelated/file-${index}.txt`,
        {
          contents: Buffer.from(`unused ${index}\n`).toString("base64"),
          encoding: "base64" as const,
        },
      ])),
      install: { args: ["install", "--frozen-lockfile"], command: "pnpm", cwd: "." },
      packagePath: ".",
    }
    const source = [
      "import { execFile } from 'node:child_process'",
      "import { constants } from 'node:fs'",
      "import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'",
      "import { tmpdir } from 'node:os'",
      "import { join } from 'node:path'",
      "import { promisify } from 'node:util'",
      "const exec = promisify(execFile)",
      "export default { run: async () => {",
      "  const workspace = await mkdtemp(join(tmpdir(), 'analysis-'))",
      "  await mkdir(join(workspace, 'repo'))",
      "  await access('/usr/bin/git', constants.X_OK)",
      "  await exec('git', ['--version'], { cwd: workspace })",
      "  await rm(workspace, { recursive: true })",
      "} }",
      "",
    ].join("\n")

    const bundle = await bundleSandboxDefinition(source, "/fixture/run.sandbox.ts", {
      execution: "definition",
      project,
    })

    expect(bundle).not.toHaveProperty("project")
    expect(bundle.entry).toBe("definition.js")
    expect(bundle.modules[bundle.entry]).toContain('from "node:fs/promises"')
  })

  it.each([
    [
      "child process executable",
      "import { execFile } from 'node:child_process'\nexport default { run: async () => execFile('./scripts/task.sh') }\n",
    ],
    [
      "SQLite database",
      "import { DatabaseSync } from 'node:sqlite'\nexport default { run: async () => new DatabaseSync('./data/app.db').close() }\n",
    ],
  ])("keeps project assets used as a %s", async (_name, source) => {
    const project: SandboxProject = {
      digest: "builtin-asset-fixture",
      files: {
        "data/app.db": { contents: "", encoding: "base64" },
        "scripts/task.sh": { contents: "", encoding: "base64" },
      },
      install: { args: ["install"], command: "pnpm", cwd: "." },
      packagePath: ".",
    }

    const bundle = await bundleSandboxDefinition(source, "/fixture/run.sandbox.ts", {
      execution: "definition",
      project,
    })

    expect(bundle.project?.files).toEqual(project.files)
    expect(bundle.entry).toBe(".vitehub-sandbox/definition.js")
  })

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

  it("keeps project assets resolved relative to the Definition module", async () => {
    const project: SandboxProject = {
      digest: "module-asset-fixture",
      files: {
        "prompt.md": {
          contents: Buffer.from("Project prompt\n").toString("base64"),
          encoding: "base64",
        },
        "run.sandbox.ts": {
          contents: Buffer.from("definition source\n").toString("base64"),
          encoding: "base64",
        },
      },
      install: { args: ["install"], command: "pnpm", cwd: "." },
      packagePath: ".",
    }
    const source = [
      "import * as fs from 'node:fs/promises'",
      "export default { run: async () => await fs.readFile(new URL('./prompt.md', import.meta.url), 'utf8') }",
      "",
    ].join("\n")

    const bundle = await bundleSandboxDefinition(source, "/fixture/run.sandbox.ts", {
      execution: "definition",
      project,
    })

    expect(bundle.project?.files).toHaveProperty("prompt.md")
    expect(bundle.entry).toBe(".vitehub-sandbox/definition.js")
  })
})
