import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { resolveConsoleSectionIds } from "../src/console/runtime/sections"

const component = (name: string) => readFileSync(
  new URL(`../src/console/runtime/components/${name}.vue`, import.meta.url),
  "utf8",
)

describe("shared Console navigation layout", () => {
  it("renders one navigation rail on every Console page", () => {
    const frame = component("console-frame")
    expect(frame).toContain('<ConsoleRail :active="active" :sections-base="sectionsBase" />')
    const pages = {
      "console-home": '<ConsoleFrame :sections-base="sectionsBase">',
      "console-env": '<ConsoleFrame active="env" :sections-base="sectionsBase">',
      "console-kv": '<ConsoleFrame active="kv" :sections-base="sectionsBase">',
      "console-connections": '<ConsoleFrame active="connections" :sections-base="sectionsBase">',
      "console-blob": '<ConsoleFrame active="blob" :sections-base="sectionsBase">',
      "console-database": '<ConsoleFrame active="databases" :sections-base="sectionsBase">',
      "console-definitions": '<ConsoleFrame :active="section" :sections-base="sectionsBase">',
      "console-app": `<ConsoleFrame :active="isUsageRoute ? 'usage' : 'agents'" :sections-base="sectionsBase">`,
    }
    for (const [name, frameTag] of Object.entries(pages)) {
      expect(component(name)).toContain(frameTag)
      expect(component(name)).not.toContain("ConsolePrimitiveSwitcher")
      expect(component(name)).not.toContain("ConsoleSectionNav")
    }
    const rail = component("console-rail")
    expect(rail).toContain("groupConsoleSections(")
    expect(rail).toContain('<PrimitiveRail class="vitehub-console__rail" label="Console">')
    expect(rail).toContain(':current="section.id === active"')
    expect(rail).toContain("<UDashboardSearchButton")
  })

  it("shows the appearance menu between search and sign-out only in the standalone Console", () => {
    const rail = component("console-rail")
    expect(rail).toContain("inject(consoleAppearanceKey, undefined)")
    expect(rail).toMatch(/<UDashboardSearchButton[\s\S]*?<UDropdownMenu\s+v-if="appearance"[\s\S]*?<UTooltip v-if="signedIn"/)
    expect(rail).toMatch(/type: "checkbox",[\s\S]*?checked: appearance\?\.preference\.value === option/)
    expect(component("console-search")).toContain("inject(consoleAppearanceKey, undefined)")
    const client = readFileSync(new URL("../src/console/runtime/client/main.js", import.meta.url), "utf8")
    // The stored appearance applies before mount, so the first render uses the chosen scheme.
    expect(client).toMatch(/startConsoleAppearance\([\s\S]*?\.provide\(consoleAppearanceKey, appearance\)[\s\S]*?\.mount\("#app"\)/)
    // Nuxt UI color mode would write the root class from a second, origin-wide storage key.
    expect(readFileSync(new URL("../console.vite.config.ts", import.meta.url), "utf8")).toContain("colorMode: false")
  })

  it("registers Go to chords in the rail and shows them in tooltips and search", () => {
    const rail = component("console-rail")
    expect(rail).toContain('import { defineShortcuts } from "@nuxt/ui/composables"')
    expect(rail).toContain('[consoleOverviewShortcut.join("-")]: () => openShortcut("vitehub-console")')
    expect(rail).toContain('if (section.shortcut) shortcuts[section.shortcut.join("-")] = () => openShortcut(section.routeName)')
    expect(rail).toContain(':kbds="section.shortcut ? [...section.shortcut] : undefined"')
    const search = component("console-search")
    expect(search).toContain('label: "Go to"')
    expect(search).toContain("kbds: [...consoleOverviewShortcut]")
    expect(search).toContain('"/": () => {')
    expect(search).toContain("<template #footer>")
    const app = component("console-app")
    expect(app).toContain(':actions="searchActions"')
    expect(app).toContain('label: "New chat"')
  })

  it("titles each context panel with its section and drops sidebars that only held navigation", () => {
    for (const name of ["console-definitions", "console-blob", "console-database"]) {
      expect(component(name)).toContain('class="vitehub-console__panel-title"')
      expect(component(name)).toContain('class="vitehub-console__nav"')
      // A bound `:id` evaluates `console - navigation` and stores the sidebar size under "NaN".
      expect(component(name)).toMatch(/\sid="console-navigation"/)
      expect(component(name)).not.toContain(':id="console-navigation"')
    }
    for (const name of ["console-home", "console-env", "console-kv", "console-connections"]) {
      expect(component(name)).not.toContain("<UDashboardSidebar")
      expect(component(name)).toContain(':toggle="false"')
    }
    expect(component("console-app")).toContain('v-if="!isUsageRoute"\n      id="agent-sessions"')
  })

  it("groups the Overview sections and keeps one open button for each section", () => {
    const home = component("console-home")
    expect(home).toContain("groupConsoleSections(availableSections.value)")
    expect(home).toContain("consoleSectionGroupLabels[id]")
    expect(home).toContain(':aria-label="`Open ${section.label}`"')
    expect(home).toContain("readLastConsoleSection()")
    expect(home).toContain('useCollection("vitehub-console-search"')
  })

  it("links Overview sections to their docs without nesting links in buttons", () => {
    const home = component("console-home")
    // The open button covers the cell and the Docs link sits beside it, never inside it.
    expect(home).toMatch(/<button\s+type="button"\s+class="vitehub-console__overview-cell-target absolute inset-0"[^>]*\/>/)
    expect(home).toContain(':href="section.docs"')
    expect(home).toContain(':aria-label="`${section.label} documentation`"')
    expect(home).toContain('consolePrimitives.filter((entry) => entry.id !== "usage" && !sections.value.includes(entry.id))')
    expect(home).toContain(':aria-label="`Set up ${entry.label}`"')
    expect(home).toContain('v-for="guide in consoleGuides"')
    expect(home).toContain("Add your first primitive")
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

  it("lists Agents in the Agents panel and marks the selected Agent", () => {
    const app = component("console-app")
    expect(app).toMatch(/class="vitehub-console__panel-title[^"]*">\s*<span class="min-w-0 flex-1 truncate">Agents<\/span>/)
    expect(app).not.toContain("<UDropdownMenu")
    expect(app).not.toContain("<UDashboardSearchButton")
    expect(app).toContain('aria-label="Filter sessions"')
    expect(app).toContain('<section v-if="hasMultipleAgents" class="vitehub-console__agents')
    // The selected row exposes its state to assistive technology, not only through color.
    expect(app).toMatch(/v-for="name in agentRows\.visible"[\s\S]*?:aria-current="name === selectedAgentName \? 'true' : undefined"[\s\S]*?@click="selectAgent\(name\)"/)
    expect(app).toContain("Show {{ agentRows.hidden }} more")
    expect(app).toMatch(/<span>Sessions<\/span>\s*<span v-if="selectedAgentName"/)
    expect(app).toContain('group-by="recency"')
  })

  it("generates the Tailwind classes that the Console app config declares", () => {
    const styles = readFileSync(new URL("../src/console/runtime/client/styles.css", import.meta.url), "utf8")
    const appConfig = readFileSync(new URL("../src/console/app.config.ts", import.meta.url), "utf8")
    expect(appConfig).toContain("bg-(color:--vitehub-console-floating)")
    expect(styles).toContain('@source "../../app.config.ts";')
    expect(styles).toMatch(/--vitehub-console-floating:/)
  })

  it("loads the Workspace when its active tab is reopened from a file", () => {
    const inspector = component("console-session-inspector")
    expect(inspector).toMatch(/selectedPath\.value = undefined;[\s\S]*?if \(!workspace\.value && !workspaceLoading\.value\) void loadWorkspace\(\);/)
  })
})
