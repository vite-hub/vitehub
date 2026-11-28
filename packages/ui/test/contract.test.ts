import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { beforeAll, describe, expect, it } from "vitest"

import { uiMigrations } from "../contract/migrations.ts"
import { buildReport, entrySources, serializeReport } from "../contract/report.ts"
import type { ApiComponent, ApiReport } from "../contract/report.ts"
import { componentViolations, contractViolations, violationKey } from "../contract/rules.ts"
import type { Violation } from "../contract/rules.ts"
import packageJson from "../package.json" with { type: "json" }

const packageRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "")
const contractFile = (name: string) => readFileSync(new URL(`../contract/${name}`, import.meta.url), "utf8")

let report: ApiReport

beforeAll(() => {
  report = buildReport(packageRoot)
}, 180_000)

describe("api.json", () => {
  it("is current", () => {
    expect(serializeReport(report), "contract/api.json is stale. Run `pnpm run contract:api` in packages/ui and commit the result.").toBe(contractFile("api.json"))
  })

  it("reads every JavaScript entry of package.json", () => {
    const entries = Object.entries(packageJson.exports).flatMap(([key, value]) => (typeof value === "object" && "import" in value ? [key] : []))
    expect(Object.keys(entrySources).sort()).toEqual(entries.sort())
  })

  it("names each component once", () => {
    const names = report.components.map((component) => component.name)
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([])
  })
})

describe("the props contract", () => {
  const probe = (component: Partial<ApiComponent>): ApiComponent => ({
    name: "Probe",
    entries: ["."],
    source: "src/components/probe.ts",
    props: [],
    events: [],
    slots: [],
    dataSlots: ["probe"],
    dataAttributes: [],
    types: ["ProbeProps"],
    ...component,
  })
  const rules = (component: Partial<ApiComponent>) => componentViolations(probe(component)).map(violationKey)

  it("accepts a component that follows every rule", () => {
    expect(rules({
      props: [
        { name: "open", type: "boolean | undefined", default: "false", required: false },
        { name: "defaultOpen", type: "boolean | undefined", required: false },
        { name: "tone", type: "\"neutral\" | \"error\" | undefined", values: ["error", "neutral"], required: false },
      ],
      events: [{ name: "update:open", type: "[open: boolean]" }],
      slots: ["default"],
      types: ["ProbeProps", "ProbeEmits", "ProbeSlots"],
    })).toEqual([])
  })

  it("finds each break", () => {
    expect(rules({
      props: [
        { name: "ui", type: "Record<string, string> | undefined", required: false },
        { name: "contentClass", type: "string | undefined", required: false },
        { name: "color", type: "string | undefined", required: false },
        { name: "as", type: "string | undefined", required: false },
        { name: "trailingIcon", type: "string | undefined", required: false },
        { name: "hideLabel", type: "boolean | undefined", required: false },
        { name: "attachments", type: "boolean | undefined", default: "true", required: false },
        { name: "client", type: "any", required: false },
        { name: "size", type: "\"xl\" | undefined", values: ["xl"], required: false },
        { name: "variant", type: "string | undefined", required: false },
      ],
      events: [{ name: "update:sidebar", type: "[open: boolean]" }],
      slots: ["default"],
      dataSlots: ["probe-root"],
      dataAttributes: ["data-state"],
      types: [],
    })).toEqual([
      "Probe ui-prop ui",
      "Probe class-prop contentClass",
      "Probe color-prop color",
      "Probe as-prop as",
      "Probe icon-string trailingIcon",
      "Probe negative-boolean hideLabel",
      "Probe boolean-default-true attachments",
      "Probe any-type client",
      "Probe size-values size",
      "Probe variant-values variant",
      "Probe update-without-prop sidebar",
      "Probe model-without-default sidebar",
      "Probe props-type",
      "Probe emits-type",
      "Probe slots-type",
      "Probe root-data-slot",
      "Probe data-state",
    ])
  })
})

describe("violations.json", () => {
  const listed: Violation[] = JSON.parse(contractFile("violations.json"))

  it("lists no new violation", () => {
    const known = new Set(listed.map(violationKey))
    const added = contractViolations(report).filter((violation) => !known.has(violationKey(violation))).map(violationKey)
    expect(added, "These break the props contract in contract/CONTRACT.md. Fix them; do not add them to violations.json.").toEqual([])
  })

  it("lists only violations that still exist", () => {
    const current = new Set(contractViolations(report).map(violationKey))
    const fixed = listed.filter((violation) => !current.has(violationKey(violation))).map(violationKey)
    expect(fixed, "These are fixed. Remove them from contract/violations.json, so the list only gets shorter.").toEqual([])
  })
})

describe("migrations.ts", () => {
  it("has a row for each name that left api.json since the base branch", () => {
    const base = baseReport()
    if (!base) return
    const current = new Map(report.components.map((component) => [component.name, component]))
    const covered = (component: string, from: string) => uiMigrations.some((row) => row.component === component && row.from === from)
    const missing: string[] = []
    for (const before of base.components) {
      const after = current.get(before.name)
      if (!after) {
        if (!covered(before.name, before.name)) missing.push(`${before.name} (component)`)
        continue
      }
      const kept = {
        prop: new Set(after.props.map((prop) => prop.name)),
        event: new Set(after.events.map((event) => event.name)),
        slot: new Set(after.slots),
      }
      const removed = [
        ...before.props.map((prop) => ["prop", prop.name] as const),
        ...before.events.map((event) => ["event", event.name] as const),
        ...before.slots.map((slot) => ["slot", slot] as const),
      ].filter(([kind, name]) => !kept[kind].has(name))
      for (const [kind, name] of removed) if (!covered(before.name, name)) missing.push(`${before.name} ${name} (${kind})`)
    }
    expect(missing, "Add a row to contract/migrations.ts for each name, so `vitehub migrate` and the migration page know where it went.").toEqual([])
  })

  it("names only known components and kinds", () => {
    const kinds = new Set(["prop", "event", "slot", "component", "removed"])
    for (const row of uiMigrations) {
      expect(kinds.has(row.kind), `${row.component} ${row.from}`).toBe(true)
      expect(row.note.length, `${row.component} ${row.from} needs a note`).toBeGreaterThan(0)
    }
  })
})

describe("audit.md", () => {
  it("covers every component of api.json", () => {
    const audit = contractFile("audit.md")
    expect(report.components.map((component) => component.name).filter((name) => !audit.includes(`\`${name}\``))).toEqual([])
  })
})

function baseReport(): ApiReport | undefined {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: packageRoot, encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] }).trim()
  const base = git("merge-base", "HEAD", `origin/${process.env.GITHUB_BASE_REF || "main"}`)
  const file = `${base}:${git("rev-parse", "--show-prefix")}contract/api.json`
  try {
    git("cat-file", "-e", file)
  }
  catch {
    return undefined
  }
  return JSON.parse(git("show", file))
}
