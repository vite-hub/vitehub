import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

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
      expect(component(name)).toContain("border border-default")
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
    expect(definitions).toContain("Boolean(props.scheduleRunBase && selectedDefinition.value?.runnable)")
    expect(readFileSync(new URL("../src/console/runtime/pages/schedules.vue", import.meta.url), "utf8")).toContain(':schedule-run-base="`${appBaseURL}/api/_vitehub/console/schedule-run`"')
    expect(readFileSync(new URL("../src/console/runtime/client/main.js", import.meta.url), "utf8")).toContain('scheduleRunBase: "/api/_vitehub/console/schedule-run"')
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
