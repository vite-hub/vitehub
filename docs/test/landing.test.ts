import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { agentBoundaries, landingLanes, serverPrimitives } from "../app/components/landing/content"

const landingFiles = [
  "Hero.vue",
  "Relationship.vue",
  "Quickstarts.vue",
  "Cta.vue",
  "content.ts",
]

describe("landing page", () => {
  it("presents two complete and equally actionable product lanes", () => {
    expect(landingLanes).toHaveLength(2)
    expect(landingLanes.map(lane => lane.id)).toEqual(["server-primitives", "agents"])

    for (const lane of landingLanes) {
      expect(lane.tutorialPath).toMatch(/^\/docs\/getting-started\//)
      expect(lane.docsPath).toMatch(/^\/docs\//)
      expect(lane.code).toContain("export default")
      expect(lane.outcomes).toHaveLength(3)
    }

    expect(landingLanes[0].codeLabel).toBe("src/server.ts")
    expect(landingLanes[0].code).toContain("new H3()")
  })

  it("keeps the two layers explicit", () => {
    expect(serverPrimitives.map(primitive => primitive.name)).toEqual([
      "Auth",
      "Env",
      "KV",
      "Database",
      "Blob",
      "Workspace",
      "Source",
      "Queue",
      "Workflow",
      "Schedule",
      "Sandbox",
      "Shell",
    ])
    expect(agentBoundaries.map(boundary => boundary.name)).toEqual([
      "Driver",
      "Workspace",
      "Capabilities",
      "Instructions",
      "Channels",
    ])
  })

  it("uses deterministic landing components and qualified portability copy", async () => {
    const source = (
      await Promise.all(
        landingFiles.map(file => readFile(new URL(`../app/components/landing/${file}`, import.meta.url), "utf8")),
      )
    ).join("\n")

    expect(source).not.toMatch(/Math\.random|Date\.now|window\.matchMedia/)
    expect(source).not.toMatch(/Agents for any host|Deploy anywhere|Write it once/)
    expect(source).not.toMatch(/claudeCode\(\)|workspace:\s*\{\s*source:/)
    expect(source).not.toMatch(/auth\.getSession|from ['"]@vite-hub\/database['"]/)
  })
})
