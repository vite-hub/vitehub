import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

import { buildHints, outputFileExists, providerEnabled, readOutputFile, repoRoot } from "./helpers.ts"

const SERVER_FUNC = "playground/vite/.vercel/output/functions/__server.func/index.mjs"
const CONFIG = "playground/vite/.vercel/output/config.json"
const SCHEDULE_FUNC = "playground/vite/.vercel/output/functions/api/vitehub/schedules/vercel/daily-marker.func/index.mjs"
const WORKFLOW_MANIFEST = "playground/vite/.vercel/output/functions/.well-known/workflow/v1/manifest.json"

const bundle = () => readOutputFile(SERVER_FUNC, buildHints.vercel)
const config = () => JSON.parse(readOutputFile(CONFIG, buildHints.vercel))

describe.runIf(providerEnabled("vercel"))("vercel provider output", () => {
  it("bundle excludes the Cloudflare Artifacts store implementation", () => {
    expect(/createCloudflareArtifactsWorkspaceStore|isomorphic-git/.test(bundle())).toBe(false)
  })

  it("bundle excludes Cloudflare-only sandbox runtime code", () => {
    expect(bundle().match(/["'](?:cloudflare:workers|@cloudflare\/sandbox(?:\/[^"'\s]*)?)["']/)?.[0]).toBeUndefined()
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

  it("registers the same welcome Workflow ID that the server starts", () => {
    const workflowId = bundle().match(/workflow\/\/\.\/[^"\s]+\/\/ViteHubWelcome\w+WorkflowNative/)?.[0]
    expect(workflowId).toBeDefined()
    expect(readOutputFile(WORKFLOW_MANIFEST, buildHints.vercel)).toContain(JSON.stringify(workflowId))
  })

  it("server function imports cleanly offline", async () => {
    readOutputFile(SERVER_FUNC, buildHints.vercel)
    const entry = pathToFileURL(resolve(repoRoot, SERVER_FUNC)).href
    await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", "await import(process.argv[1])", entry], {
      env: {
        ...process.env,
        KV_REST_API_URL: "https://localhost.invalid",
        KV_REST_API_TOKEN: "offline-contract-test",
        BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_offline_contract_test",
      },
      timeout: 10_000,
    })
  }, 15_000)
})
