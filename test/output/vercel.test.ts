import { pathToFileURL } from "node:url"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { buildHints, outputFileExists, providerEnabled, readOutputFile, repoRoot } from "./helpers.ts"

const SERVER_FUNC = "playground/vite/.vercel/output/functions/__server.func/index.mjs"
const CONFIG = "playground/vite/.vercel/output/config.json"
const SCHEDULE_FUNC = "playground/vite/.vercel/output/functions/api/vitehub/schedules/vercel/daily-marker.func/index.mjs"

const bundle = () => readOutputFile(SERVER_FUNC, buildHints.vercel)
const config = () => JSON.parse(readOutputFile(CONFIG, buildHints.vercel))

describe.runIf(providerEnabled("vercel"))("vercel provider output", () => {
  it("bundle excludes the Cloudflare Artifacts store implementation", () => {
    expect(/createCloudflareArtifactsWorkspaceStore|isomorphic-git/.test(bundle())).toBe(false)
  })

  it("bundle excludes Cloudflare-only sandbox runtime code", () => {
    expect(/cloudflare:workers|@cloudflare\/sandbox/.test(bundle())).toBe(false)
  })

  it("bundle excludes Vite runtime code", () => {
    expect(/import\(["']vite["']\)/.test(bundle())).toBe(false)
  })

  it("config.json declares the daily-marker cron", () => {
    const expected = { path: "/api/vitehub/schedules/vercel/daily-marker", schedule: "* * * * *" }
    expect(config().crons).toEqual(expect.arrayContaining([expect.objectContaining(expected)]))
  })

  it("emits the generated schedule function executing the static handler", () => {
    expect(outputFileExists(SCHEDULE_FUNC), `missing ${SCHEDULE_FUNC}`).toBe(true)
    expect(readOutputFile(SCHEDULE_FUNC, buildHints.vercel)).toContain("executeStaticSchedule")
  })

  it("server function imports cleanly offline", async () => {
    process.env.KV_REST_API_URL ||= "https://localhost.invalid"
    process.env.KV_REST_API_TOKEN ||= "offline-contract-test"
    process.env.BLOB_READ_WRITE_TOKEN ||= "vercel_blob_rw_offline_contract_test"
    readOutputFile(SERVER_FUNC, buildHints.vercel)
    await expect(import(pathToFileURL(resolve(repoRoot, SERVER_FUNC)).href)).resolves.toBeDefined()
  })
})
