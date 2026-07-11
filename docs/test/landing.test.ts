import { readFile, stat } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { landingLanes } from "../app/components/landing/content"

const landingFiles = [
  "Hero.vue",
  "Paths.vue",
  "Cta.vue",
  "content.ts",
]

describe("landing page", () => {
  it("presents two concise and equally actionable product lanes", () => {
    expect(landingLanes).toHaveLength(2)
    expect(landingLanes.map(lane => lane.id)).toEqual(["server-primitives", "agents"])

    for (const lane of landingLanes) {
      expect(lane.tutorialPath).toMatch(/^\/docs\/getting-started\//)
      expect(lane.image).toMatch(/^\/images\/landing\/.*\.webp$/)
      expect(lane.description.length).toBeLessThan(100)
      expect(lane.action.length).toBeLessThan(24)
    }
  })

  it("keeps one focal point and removes repeated landing copy", async () => {
    const source = (
      await Promise.all(
        landingFiles.map(file => readFile(new URL(`../app/components/landing/${file}`, import.meta.url), "utf8")),
      )
    ).join("\n")

    expect(source).toContain("The server layer for Vite.")
    expect(source).toContain("Use portable Server Primitives directly, or compose them into Agents.")
    expect(source).not.toMatch(/Pick this path|Verified contract|First success \/|The map \/|Your move \/|DIRECT|COMPOSED/)
    expect(source).not.toMatch(/<pre|<ul|<ol/)
    expect(source).not.toMatch(/Math\.random|Date\.now|window\.matchMedia/)
    expect(source).not.toMatch(/Agents for any host|Deploy anywhere|Write it once/)
  })

  it("ships lightweight landing artwork", async () => {
    for (const file of ["vitehub-backplane.webp", "server-primitives.webp", "agents.webp"]) {
      const metadata = await stat(new URL(`../public/images/landing/${file}`, import.meta.url))
      expect(metadata.size).toBeLessThan(200_000)
    }
  })
})
