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
      "async function inspect(path) { await access(path, constants.F_OK) }",
      "export default { run: async () => {",
      "  const workspace = await mkdtemp(join(tmpdir(), 'analysis-'))",
      "  await mkdir(join(workspace, 'repo'))",
      "  await inspect(workspace)",
      "  await exec('git', ['--version'], { cwd: workspace })",
      "  await rm(workspace, { recursive: true })",
      "} }",
      "",
    ].join("\n")

    const bundle = await bundleSandboxDefinition(source, "/fixture/run.sandbox.ts", {
      execution: "definition",
      includeProject: false,
      project,
    })

    expect(bundle).not.toHaveProperty("project")
    expect(bundle.entry).toBe("definition.js")
    expect(bundle.modules[bundle.entry]).toContain('from "node:fs/promises"')
  })

  it("forces project inclusion when the Definition declares project true", async () => {
    const project: SandboxProject = {
      digest: "forced-project-fixture",
      files: {
        "package.json": {
          contents: Buffer.from(JSON.stringify({ private: true, type: "module" })).toString("base64"),
          encoding: "base64",
        },
      },
      install: { args: ["install"], command: "pnpm", cwd: "." },
      packagePath: ".",
    }

    const bundle = await bundleSandboxDefinition(
      "export default { run: async () => 'forced' }\n",
      "/fixture/run.sandbox.ts",
      { execution: "definition", includeProject: true, project },
    )

    expect(bundle.project?.files).toEqual(project.files)
    expect(bundle.entry).toBe(".vitehub-sandbox/definition.js")
  })

  it("rejects runtime dependencies that contradict project false", async () => {
    const project: SandboxProject = {
      digest: "dynamic-project-fixture",
      files: {},
      install: { args: ["install"], command: "pnpm", cwd: "." },
      packagePath: ".",
    }
    const source = "export default { run: async name => await import(name) }\n"

    await expect(bundleSandboxDefinition(source, "/fixture/run.sandbox.ts", {
      execution: "definition",
      includeProject: false,
      project,
    })).rejects.toThrow("declares project: false but has a runtime dependency")
  })

  it.each([
    [
      "child process executable",
      "import { execFile } from 'node:child_process'\nexport default { run: async () => execFile('./scripts/task.sh') }\n",
    ],
    [
      "wrapped child process executable",
      "import { execFile } from 'node:child_process'\nimport { promisify } from 'node:util'\nconst run = promisify(execFile)\nexport default { run: async () => await run('./scripts/task.sh') }\n",
    ],
    [
      "child process shell command",
      "import { exec } from 'node:child_process'\nexport default { run: async () => exec('./scripts/task.sh --flag') }\n",
    ],
    [
      "synchronous child process shell command",
      "import { execSync } from 'node:child_process'\nexport default { run: async () => execSync('./scripts/task.sh --flag') }\n",
    ],
    [
      "child process argument",
      "import { spawn } from 'node:child_process'\nexport default { run: async () => spawn('node', ['./scripts/task.sh']) }\n",
    ],
    [
      "aliased filesystem namespace",
      "import * as fs from 'node:fs'\nconst io = fs\nexport default { run: async () => io.readFileSync('./data/app.db') }\n",
    ],
    [
      "SQLite database",
      "import { DatabaseSync } from 'node:sqlite'\nexport default { run: async () => new DatabaseSync('./data/app.db').close() }\n",
    ],
    [
      "Worker entry file",
      "import { Worker } from 'node:worker_threads'\nexport default { run: async () => new Worker('./scripts/task.sh') }\n",
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

  it.each([
    ["object", "const ops = { readFile }\nexport default { run: async () => await ops.readFile('./prompt.md', 'utf8') }"],
    ["array", "const ops = [readFile]\nexport default { run: async () => await ops[0]('./prompt.md', 'utf8') }"],
  ])("keeps the project when a filesystem binding escapes into an %s", async (_name, usage) => {
    const project: SandboxProject = {
      digest: "escaped-filesystem-binding-fixture",
      files: {
        "prompt.md": { contents: "", encoding: "base64" },
      },
      install: { args: ["install"], command: "pnpm", cwd: "." },
      packagePath: ".",
    }
    const source = [
      "import { readFile } from 'node:fs/promises'",
      usage,
      "",
    ].join("\n")

    const bundle = await bundleSandboxDefinition(source, "/fixture/run.sandbox.ts", {
      execution: "definition",
      project,
    })

    expect(bundle.project?.files).toEqual(project.files)
  })

  it("keeps project assets used through computed filesystem paths", async () => {
    const project: SandboxProject = {
      digest: "computed-path-fixture",
      files: {
        "prompts/system.md": {
          contents: Buffer.from("System prompt\n").toString("base64"),
          encoding: "base64",
        },
      },
      install: { args: ["install"], command: "pnpm", cwd: "." },
      packagePath: ".",
    }
    const source = [
      "import { readFile } from 'node:fs/promises'",
      "import { join } from 'node:path'",
      "const prompt = join('prompts', 'system.md')",
      "export default { run: async () => await readFile(prompt, 'utf8') }",
      "",
    ].join("\n")

    const bundle = await bundleSandboxDefinition(source, "/fixture/run.sandbox.ts", {
      execution: "definition",
      project,
    })

    expect(bundle.project?.files).toHaveProperty("prompts/system.md")
    expect(bundle.entry).toBe(".vitehub-sandbox/definition.js")
  })

  it("keeps project assets loaded through a createRequire alias", async () => {
    const project: SandboxProject = {
      digest: "create-require-fixture",
      files: {
        "prompt.md": {
          contents: Buffer.from("Project prompt\n").toString("base64"),
          encoding: "base64",
        },
      },
      install: { args: ["install"], command: "pnpm", cwd: "." },
      packagePath: ".",
    }
    const source = [
      "import { createRequire as makeRequire } from 'node:module'",
      "const localRequire = makeRequire(import.meta.url)",
      "const { readFileSync } = localRequire('node:fs')",
      "export default { run: async () => readFileSync('./prompt.md', 'utf8') }",
      "",
    ].join("\n")

    const bundle = await bundleSandboxDefinition(source, "/fixture/run.sandbox.ts", {
      execution: "definition",
      project,
    })

    expect(bundle.project?.files).toHaveProperty("prompt.md")
    expect(bundle.entry).toBe(".vitehub-sandbox/definition.js")
  })

  it("keeps project assets loaded through process.getBuiltinModule", async () => {
    const project: SandboxProject = {
      digest: "process-builtin-module-fixture",
      files: {
        "prompt.md": {
          contents: Buffer.from("Project prompt\n").toString("base64"),
          encoding: "base64",
        },
      },
      install: { args: ["install"], command: "pnpm", cwd: "." },
      packagePath: ".",
    }
    const source = [
      "const { readFile } = process.getBuiltinModule('node:fs/promises')",
      "export default { run: async () => await readFile('./prompt.md', 'utf8') }",
      "",
    ].join("\n")

    const bundle = await bundleSandboxDefinition(source, "/fixture/run.sandbox.ts", {
      execution: "definition",
      project,
    })

    expect(bundle.project?.files).toHaveProperty("prompt.md")
    expect(bundle.entry).toBe(".vitehub-sandbox/definition.js")
  })

  it("keeps project assets used through named filesystem object imports", async () => {
    const project: SandboxProject = {
      digest: "named-object-fixture",
      files: {
        "prompt.md": {
          contents: Buffer.from("Project prompt\n").toString("base64"),
          encoding: "base64",
        },
      },
      install: { args: ["install"], command: "pnpm", cwd: "." },
      packagePath: ".",
    }
    const source = [
      "import { promises as fs } from 'node:fs'",
      "export default { run: async () => await fs.readFile('./prompt.md', 'utf8') }",
      "",
    ].join("\n")

    const bundle = await bundleSandboxDefinition(source, "/fixture/run.sandbox.ts", {
      execution: "definition",
      project,
    })

    expect(bundle.project?.files).toHaveProperty("prompt.md")
    expect(bundle.entry).toBe(".vitehub-sandbox/definition.js")
  })

  it("keeps project assets used through dynamic filesystem imports", async () => {
    const project: SandboxProject = {
      digest: "dynamic-import-fixture",
      files: {
        "prompt.md": {
          contents: Buffer.from("Project prompt\n").toString("base64"),
          encoding: "base64",
        },
      },
      install: { args: ["install"], command: "pnpm", cwd: "." },
      packagePath: ".",
    }
    const source = [
      "export default {",
      "  run: async () => {",
      "    const fs = await import('node:fs/promises')",
      "    return await fs.readFile('./prompt.md', 'utf8')",
      "  },",
      "}",
      "",
    ].join("\n")

    const bundle = await bundleSandboxDefinition(source, "/fixture/run.sandbox.ts", {
      execution: "definition",
      project,
    })

    expect(bundle.project?.files).toHaveProperty("prompt.md")
    expect(bundle.entry).toBe(".vitehub-sandbox/definition.js")
  })

  it.each([
    [
      "CommonJS require",
      "/fixture/run.sandbox.cjs",
      "const { readFile } = require('node:fs/promises')\nmodule.exports = { run: async () => await readFile('./prompt.md', 'utf8') }\n",
    ],
    [
      "TypeScript import equals",
      "/fixture/run.sandbox.cts",
      "import fs = require('node:fs/promises')\nexport default { run: async () => await fs.readFile('./prompt.md', 'utf8') }\n",
    ],
  ])("keeps project assets used through %s filesystem bindings", async (_name, id, source) => {
    const project: SandboxProject = {
      digest: "commonjs-fixture",
      files: {
        "prompt.md": {
          contents: Buffer.from("Project prompt\n").toString("base64"),
          encoding: "base64",
        },
      },
      install: { args: ["install"], command: "pnpm", cwd: "." },
      packagePath: ".",
    }

    const bundle = await bundleSandboxDefinition(source, id, {
      execution: "definition",
      project,
    })

    expect(bundle.project?.files).toHaveProperty("prompt.md")
    expect(bundle.entry).toBe(".vitehub-sandbox/definition.js")
  })

  it("keeps project files below a directory read by the Definition", async () => {
    const project: SandboxProject = {
      digest: "directory-asset-fixture",
      files: {
        "prompts/system.md": {
          contents: Buffer.from("System prompt\n").toString("base64"),
          encoding: "base64",
        },
      },
      install: { args: ["install"], command: "pnpm", cwd: "." },
      packagePath: ".",
    }
    const source = [
      "import { readdir } from 'node:fs/promises'",
      "export default { run: async () => await readdir('./prompts') }",
      "",
    ].join("\n")

    const bundle = await bundleSandboxDefinition(source, "/fixture/run.sandbox.ts", {
      execution: "definition",
      project,
    })

    expect(bundle.project?.files).toHaveProperty("prompts/system.md")
    expect(bundle.entry).toBe(".vitehub-sandbox/definition.js")
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
