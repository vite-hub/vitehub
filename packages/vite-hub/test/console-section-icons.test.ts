import { describe, expect, it } from "vitest"

import { resolvePrimitiveIconName } from "@vite-hub/docs/primitive-rail"

import { consoleContributedSectionIcons, consoleContributedSections } from "../src/console/contributions.ts"
import { consolePrimitives } from "../src/console/runtime/sections.ts"

describe("Console section icons", () => {
  it("draws every known section with the ViteHub icon set", () => {
    const outside = consolePrimitives.filter(entry => !resolvePrimitiveIconName(entry.icon)).map(entry => `${entry.id}: ${entry.icon}`)
    expect(outside).toEqual([])
  })

  it("lists the contributed section icons that are not in the ViteHub set", () => {
    for (const section of consoleContributedSections.values()) {
      if (!section.descriptor.icon.startsWith("i-vitehub-")) expect(consoleContributedSectionIcons).toContain(section.descriptor.icon)
    }
    expect(consoleContributedSectionIcons.filter(icon => icon.startsWith("i-vitehub-"))).toEqual([])
  })
})
