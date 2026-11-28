import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import ts from "typescript"
import { beforeAll, describe, expect, it } from "vitest"

import { uiMigrations } from "../contract/migrations.ts"
import type { UISurfaceKind } from "../contract/migrations.ts"
import { buildReport, entrySources, scanSource, serializeReport } from "../contract/report.ts"
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

  it("reports forwarded, computed, and factory slots", () => {
    expect(component("Workspace").slots).toEqual(expect.arrayContaining(["bar-lead", "bar-actions", "sidebar"]))
    expect(component("WorkspaceShell").slots).toEqual(expect.arrayContaining(["editor", "preview", "terminal", "connect", "tab-*"]))
    expect(component("MessageContent").slots).toContain("default")
    expect(component("ChatSession").slots).toContain("markdown")
    expect(component("AgentSession").slots).toContain("surface-*")
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
    rootDataSlots: ["probe"],
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
      rootDataSlots: ["probe-root"],
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

  it("does not count a descendant's data-slot as a root value", () => {
    const file = ts.createSourceFile("probe.ts", `const Probe = defineComponent({
      setup() { return () => h('div', {}, [h('span', { 'data-slot': 'probe' })]) }
    })`, ts.ScriptTarget.Latest)
    const statement = file.statements[0]
    if (!statement || !ts.isVariableStatement(statement)) throw new Error("Missing probe declaration")
    const scan = scanSource(file, statement.declarationList.declarations[0]!)
    expect([...scan.dataSlots]).toEqual(["probe"])
    expect(rules({ dataSlots: [...scan.dataSlots], rootDataSlots: [...scan.rootDataSlots] })).toEqual(["Probe root-data-slot"])
    expect(component("Status").rootDataSlots).toEqual(["status"])
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

  it("cannot add exceptions to the merge-base baseline", () => {
    const base = baseContractFile<Violation[]>("violations.json")
    if (!base) return
    expect(addedViolations(base, listed), "Do not add exceptions to contract/violations.json.").toEqual([])
  })

  it("rejects a new exception even when regeneration lists it", () => {
    const existing: Violation = { component: "Status", rule: "props-type" }
    const added: Violation = { component: "Status", rule: "class-prop", prop: "contentClass" }
    expect(addedViolations([existing], [existing, added])).toEqual([violationKey(added)])
  })
})

describe("migrations.ts", () => {
  it("has a row for each name that left api.json since the base branch", () => {
    const base = baseContractFile<ApiReport>("api.json")
    if (!base) return
    expect(missingMigrations(base.components, report.components), "Add a row to contract/migrations.ts for each removed surface.").toEqual([])
  })

  it("does not let a prop migration cover a same-name slot", () => {
    const before = component("AgentSessionDetailsRow")
    expect(before.props.some((prop) => prop.name === "icon")).toBe(true)
    expect(before.slots).toContain("icon")
    const after = { ...before, props: before.props.filter((prop) => prop.name !== "icon"), slots: before.slots.filter((slot) => slot !== "icon") }
    expect(missingMigrations([before], [after])).toEqual(["AgentSessionDetailsRow icon (slot)"])
  })

  it("requires a migration when a public import or alias disappears", () => {
    const before = component("ChoicesInput")
    expect(before.entries).toEqual([".", "./headless"])
    const alias = { ...before, name: "ChoicesInputAlias" }
    expect(missingMigrations([before, alias], [{ ...before, entries: ["."] }])).toEqual([
      "ChoicesInput ./headless (entry)",
      "ChoicesInputAlias ChoicesInputAlias (component)",
    ])
  })
})

describe("audit.md", () => {
  it("covers every component of api.json", () => {
    const audit = contractFile("audit.md")
    expect(report.components.map((component) => component.name).filter((name) => !audit.includes(`\`${name}\``))).toEqual([])
  })
})

function component(name: string): ApiComponent {
  const found = report.components.find((item) => item.name === name)
  if (!found) throw new Error(`Missing component ${name}`)
  return found
}

function addedViolations(base: Violation[], current: Violation[]): string[] {
  const known = new Set(base.map(violationKey))
  return current.map(violationKey).filter((key) => !known.has(key))
}

function missingMigrations(base: ApiComponent[], current: ApiComponent[]): string[] {
  const byName = new Map(current.map((item) => [item.name, item]))
  const missing: string[] = []
  for (const before of base) {
    const check = (kind: UISurfaceKind, name: string) => {
      if (!uiMigrations.some((row) => row.component === before.name && row.from === name && row.fromKind === kind)) {
        missing.push(`${before.name} ${name} (${kind})`)
      }
    }
    const after = byName.get(before.name)
    if (!after) {
      check("component", before.name)
      continue
    }
    for (const entry of before.entries) if (!after.entries.includes(entry)) check("entry", entry)
    for (const prop of before.props) if (!after.props.some(({ name }) => name === prop.name)) check("prop", prop.name)
    for (const event of before.events) if (!after.events.some(({ name }) => name === event.name)) check("event", event.name)
    for (const slot of before.slots) if (!after.slots.includes(slot)) check("slot", slot)
  }
  return missing
}

function baseContractFile<T>(name: string): T | undefined {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: packageRoot, encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] }).trim()
  const base = git("merge-base", "HEAD", `origin/${process.env.GITHUB_BASE_REF || "main"}`)
  const file = `${base}:${git("rev-parse", "--show-prefix")}contract/${name}`
  try {
    git("cat-file", "-e", file)
  }
  catch {
    return undefined
  }
  return JSON.parse(git("show", file))
}
