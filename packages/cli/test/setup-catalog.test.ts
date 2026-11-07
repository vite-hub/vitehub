import { featureHosts, featureIds } from "@vite-hub/internal/features"
import { describe, expect, it } from "vitest"

import { createProject, runSetup } from "./setup-helpers.ts"

import type { SetupCatalog } from "../src/setup/index.ts"

describe("vitehub catalog", () => {
  it("runs outside a project", async () => {
    const root = await createProject()

    const human = await runSetup(["catalog"], root)
    expect(human.exitCode).toBe(0)
    expect(human.stdout).toMatch(/^feature +dev +cloudflare +vercel +netlify +deno +node\n/u)
    expect(human.stdout).toMatch(/\nblob +fs +R2 +Vercel Blob +Netlify Blobs +S3 \(set blob\.driver\) +fs \/ S3\n/u)

    const json = await runSetup(["catalog", "--json"], root)
    expect(json.exitCode).toBe(0)
    expect(json.stderr).toBe("")
    expect(human.loadConfig).not.toHaveBeenCalled()
    expect(json.loadConfig).not.toHaveBeenCalled()
  })

  it("prints one schema version and every feature for every host", async () => {
    const { json, stdout } = await runSetup<SetupCatalog>(["catalog", "--json"], await createProject())

    expect(stdout.trimEnd().split("\n")).toHaveLength(1)
    expect(json.schemaVersion).toBe(1)
    expect(json.hosts).toEqual([...featureHosts])
    expect(json.features.map(feature => feature.id)).toEqual([...featureIds])
    for (const feature of json.features) expect(Object.keys(feature.hosts).sort()).toEqual([...featureHosts].sort())
  })

  it("rejects an unknown argument with the error envelope", async () => {
    const { exitCode, json } = await runSetup<{ schemaVersion: number, error: { code: string, fix: string } }>(["catalog", "--jsn", "--json"], await createProject())

    expect(exitCode).toBe(1)
    expect(json.schemaVersion).toBe(1)
    expect(json.error.code).toBe("CLI_R0003")
    expect(json.error.fix).toContain("--help")
  })
})
