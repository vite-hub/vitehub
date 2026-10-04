import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { resolveConsoleSectionIds } from "../src/console/runtime/sections"

const component = (name: string) => readFileSync(
  new URL(`../src/console/runtime/components/${name}.vue`, import.meta.url),
  "utf8",
)

describe("shared Console navigation layout", () => {
  it("uses one branded header and one aligned search row across primitive modules", () => {
    expect(component("console-brand")).toContain('<ConsoleMark class="size-4 shrink-0" />')
    for (const name of ["console-home", "console-definitions", "console-blob", "console-database", "console-kv"]) {
      expect(component(name)).toContain("<ConsoleBrand")
      expect(component(name)).toContain("vitehub-console__search")
      expect(component(name)).toContain('class="vitehub-console__nav"')
      // A bound `:id` evaluates `console - navigation` and stores the sidebar size under "NaN".
      expect(component(name)).toMatch(/\sid="console-navigation"/)
      expect(component(name)).not.toContain(':id="console-navigation"')
    }
  })

  it("keeps primitive identity in the page header instead of repeating sidebar headings", () => {
    expect(component("console-definitions")).not.toContain(">Definitions</h1>")
    expect(component("console-blob")).not.toContain(">Objects</h1>")
    expect(component("console-database")).not.toContain("tracking-[.1em] text-muted\">\n            Database")
  })

  it("shows Run now next to the Read-only badge only for runnable Schedules", () => {
    const definitions = component("console-definitions")
    expect(definitions).toMatch(/<template #right>\s*<UButton\s+v-if="canRunSelected"[\s\S]*?label="Run now"[\s\S]*?<UBadge color="neutral" label="Read-only"/)
    expect(definitions).toContain("Boolean(props.scheduleRunBase && (selectedDefinition.value?.runnable || selectedRecord.value?.runnable))")
    expect(readFileSync(new URL("../src/console/runtime/client/main.js", import.meta.url), "utf8")).toContain('scheduleRunBase: consolePath("/api/_vitehub/console/schedule-run")')
    expect(readFileSync(new URL("../src/console/runtime/pages/section.vue", import.meta.url), "utf8")).toContain(':schedule-run-base="`${appBaseURL}/api/_vitehub/console/schedule-run`"')
  })

  it("opens the Database table route in data mode", () => {
    const routes = readFileSync(new URL("../src/console/runtime/client/main.js", import.meta.url), "utf8")
    expect(routes).toMatch(/name: "vitehub-console-databases",[\s\S]*?view: "data"/)
  })

  it("enables every registered Database route through navigation", () => {
    const routes = readFileSync(new URL("../src/console/runtime/client/main.js", import.meta.url), "utf8")
    const enabled = resolveConsoleSectionIds({ database: true })
    const databaseSections = [...routes.matchAll(/consoleSection: "(databases?)"/g)].map(match => match[1])
    expect(databaseSections).toHaveLength(2)
    for (const section of databaseSections) expect(enabled).toContain(section)
  })

  it("renders Usage as the same accessible icon primitive everywhere", () => {
    const switcher = component("console-primitive-switcher")
    expect(switcher).toContain(':text="consoleSectionDetails.usage.label"')
    expect(switcher).toContain(':icon="consoleSectionDetails.usage.icon"')
    expect(switcher).not.toContain('label="Usage"')
  })

  it("loads the Workspace when its active tab is reopened from a file", () => {
    const inspector = component("console-session-inspector")
    expect(inspector).toMatch(/selectedPath\.value = undefined;[\s\S]*?if \(!workspace\.value && !workspaceLoading\.value\) void loadWorkspace\(\);/)
  })
})
