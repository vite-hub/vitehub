import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { createDecisionsCliNamespace } from "../src/cli.ts"

const app = fileURLToPath(new URL("./fixtures/cli/app", import.meta.url))
const broken = fileURLToPath(new URL("./fixtures/cli/broken", import.meta.url))

async function cli(rootDir: string, feature: "list" | "run", ...args: string[]) {
  let stdout = ""
  let stderr = ""
  const command = createDecisionsCliNamespace().features.find(item => item.name === feature)!
  const code = await command.run(args, {
    cwd: rootDir,
    env: {},
    rootDir,
    spawn: async () => ({ exitCode: 0 }),
    stderr: { write: (chunk) => { stderr += String(chunk) } },
    stdout: { write: (chunk) => { stdout += String(chunk) } },
  })
  return { code, stderr, stdout }
}

describe("vitehub decisions list", () => {
  it("lists every export from defineChoices() by file, without a registry", async () => {
    const result = await cli(app, "list")
    expect(result.code).toBe(0)
    expect(result.stdout).toBe([
      "FILE                              EXPORT    NAME",
      "server/utils/forecast-choices.ts  forecast  forecast",
      "server/utils/sites.ts             sites     -",
      "server/utils/sites.ts             status    status",
      "",
      "Run one with: vitehub decisions run server/utils/forecast-choices.ts \"<text>\"",
      "",
    ].join("\n"))
  })

  it("prints JSON with --json", async () => {
    const result = await cli(app, "list", "--json")
    expect(JSON.parse(result.stdout)).toEqual({
      files: [
        { choices: [{ export: "forecast", name: "forecast" }], file: "server/utils/forecast-choices.ts" },
        { choices: [{ export: "sites" }, { export: "status", name: "status" }], file: "server/utils/sites.ts" },
      ],
    })
  })

  it("says so when no file exports a Decision", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-decisions-cli-"))
    try {
      await writeFile(join(root, "notes.ts"), "// defineChoices() is not called here.\nexport const value = 1\n")
      expect(await cli(root, "list")).toEqual({ code: 0, stderr: "", stdout: "No file exports the result of defineChoices().\n" })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("reports a file that fails to load and exits 1", async () => {
    const result = await cli(broken, "list", "--json")
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({ files: [{ choices: [], error: expect.stringContaining("The options database is offline."), file: "server/choices.mjs" }] })
  })
})

describe("vitehub decisions run", () => {
  it("prints the selection as JSON", async () => {
    const result = await cli(app, "run", "server/utils/forecast-choices.ts", "bar chart of nord parts except vak supply")
    expect(result).toMatchObject({ code: 0, stderr: "" })
    expect(JSON.parse(result.stdout)).toEqual({
      chart: { confidence: 0.8, ranked: [{ probability: 0.8, value: "bar" }, { probability: expect.any(Number), value: "line" }], value: "bar" },
      supplier: { exclude: ["S1"], include: ["S2"] },
    })
  })

  it("joins the words after the file into one text", async () => {
    const result = await cli(app, "run", "server/utils/forecast-choices.ts", "nord", "parts")
    expect(JSON.parse(result.stdout).supplier).toEqual({ exclude: [], include: ["S2"] })
  })

  it("prints the questions without a model call with --inspect", async () => {
    const result = await cli(app, "run", "server/utils/forecast-choices.ts", "nord parts", "--inspect")
    expect(result.code).toBe(0)
    const plan = JSON.parse(result.stdout)
    expect(plan.state.query).toBe("nord parts")
    expect(Object.keys(plan.questions)).toEqual(["supported", "g0", "g1_o0", "g1_o1"])
  })

  it("asks for --export when a file has several Decisions, and passes --context to options", async () => {
    const ambiguous = await cli(app, "run", "server/utils/sites.ts", "berlin")
    expect(ambiguous).toMatchObject({ code: 1, stdout: "" })
    expect(ambiguous.stderr).toContain("several exports from defineChoices(): sites, status. Pick one with --export.")

    const result = await cli(app, "run", "server/utils/sites.ts", "berlin but not madrid", "--export", "sites", "--context", "{\"tenantId\":\"t1\"}")
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ site: { exclude: ["mad"], include: ["ber"] } })
  })

  it("prints a Decision error as JSON and exits 1", async () => {
    const result = await cli(app, "run", "server/utils/forecast-choices.ts", "unsupported price above 100")
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({ error: { code: "DECISIONS_R0004", message: expect.stringContaining("cannot express that text") } })
  })

  it("explains wrong arguments on stderr", async () => {
    expect((await cli(app, "run", "server/utils/forecast-choices.ts")).stderr).toContain("Give a file and a text.")
    expect((await cli(app, "run", "server/utils/missing.ts", "text")).stderr).toContain("server/utils/missing.ts is not a file. Run vitehub decisions list")
    expect((await cli(app, "run", "server/utils/notes.ts", "text")).stderr).toContain("has no export from defineChoices()")
    expect((await cli(app, "run", "server/utils/sites.ts", "text", "--export", "nope")).stderr).toContain("has no export \"nope\". Its exports from defineChoices() are: sites, status.")
    expect((await cli(app, "run", "server/utils/sites.ts", "text", "--context", "{")).stderr).toContain("--context must be JSON")
    const unknown = await cli(app, "run", "--model", "x")
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain(`Usage: vitehub decisions run <file> <text>`)
  })
})
