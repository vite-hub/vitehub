import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"

import { isScratchName, teardownCloudflare } from "../.github/scripts/live-smoke-teardown.mjs"

const repoRoot = resolve(import.meta.dirname, "..")
const scriptPath = resolve(repoRoot, ".github/scripts/live-smoke-teardown.mjs")
const prefix = "vitehub-smoke-123"

interface Call { method: string, path: string, query: Record<string, string> }
type Route = (call: Call) => { status?: number, body: unknown } | undefined

function ok(result: unknown, extra: Record<string, unknown> = {}) {
  return { body: { success: true, errors: [], result, ...extra } }
}

function notFound() {
  return { status: 404, body: { success: false, errors: [{ code: 10007, message: "not found" }] } }
}

function createFakeCloudflare(route: Route) {
  const calls: Call[] = []
  const fetch = async (input: URL | string, init?: RequestInit) => {
    const url = new URL(input)
    const call = {
      method: init?.method ?? "GET",
      path: url.pathname.replace("/client/v4/accounts/account", ""),
      query: Object.fromEntries(url.searchParams),
    }
    calls.push(call)
    const response = route(call) ?? (call.method === "DELETE" ? notFound() : ok([]))
    return new Response(JSON.stringify(response.body), { status: response.status ?? 200, headers: { "content-type": "application/json" } })
  }
  return { calls, fetch }
}

const deletes = (calls: Call[]) => calls.filter(call => call.method === "DELETE").map(call => call.path)

describe("live smoke teardown", () => {
  it("matches the run prefix and nothing else", () => {
    expect(isScratchName(prefix, prefix)).toBe(true)
    expect(isScratchName(`${prefix}-db`, prefix)).toBe(true)
    expect(isScratchName(`${prefix}4`, prefix)).toBe(false)
    expect(isScratchName("vitehub-smoke-1234-db", prefix)).toBe(false)
    expect(isScratchName("vitehub-playground-vite", prefix)).toBe(false)
    expect(isScratchName(undefined, prefix)).toBe(false)
  })

  it("deletes only the resources of this run", async () => {
    const deletedImages: string[] = []
    const { calls, fetch } = createFakeCloudflare(({ method, path }) => {
      if (method === "DELETE") return ok(null)
      if (path === "/containers/applications") return ok([{ id: "app-1", name: `${prefix}-sandbox` }, { id: "app-2", name: "vitehub-playground-vite-sandbox" }])
      if (path === "/workflows") return ok([{ name: `${prefix}-welcome` }, { name: "workflow--77656c636f6d65" }])
      if (path === "/queues") return ok([{ queue_id: "q-1", queue_name: `${prefix}-welcome-email` }, { queue_id: "q-2", queue_name: "vitehub-smoke-1234-welcome-email" }])
      if (path === "/d1/database") return ok([{ uuid: "d1-1", name: `${prefix}-db` }, { uuid: "d1-2", name: `${prefix}-analytics` }, { uuid: "d1-3", name: "vitehub-smoke-1230-db" }])
      if (path === "/storage/kv/namespaces") return ok([{ id: "kv-1", title: `${prefix}-kv` }, { id: "kv-2", title: "vitehub-playground-kv" }])
      if (path === "/r2/buckets") return ok({ buckets: [{ name: prefix }, { name: `${prefix}9` }] })
    })
    const { deleted, failures } = await teardownCloudflare({
      accountId: "account",
      apiToken: "token",
      prefix,
      fetch,
      images: {
        list: () => [{ name: `${prefix}-sandbox`, tags: ["abc"] }, { name: "vitehub-playground-vite-sandbox", tags: ["def"] }],
        delete: (image: string) => { deletedImages.push(image) },
      },
      log: () => {},
    })

    expect(failures).toEqual([])
    expect(deletes(calls)).toEqual([
      "/containers/applications/app-1",
      `/workers/scripts/${prefix}`,
      `/workflows/${prefix}-welcome`,
      "/queues/q-1",
      "/d1/database/d1-1",
      "/d1/database/d1-2",
      "/storage/kv/namespaces/kv-1",
      `/r2/buckets/${prefix}`,
    ])
    expect(calls.find(call => call.path === `/workers/scripts/${prefix}`)?.query).toEqual({ force: "true" })
    expect(deletedImages).toEqual([`${prefix}-sandbox:abc`])
    expect(deleted).toHaveLength(9)
  })

  it("succeeds when the run created nothing", async () => {
    const { calls, fetch } = createFakeCloudflare(() => undefined)
    const result = await teardownCloudflare({ accountId: "account", apiToken: "token", prefix, fetch, log: () => {} })

    expect(result).toEqual({ deleted: [], failures: [] })
    expect(deletes(calls)).toEqual([`/workers/scripts/${prefix}`])
  })

  it.each([
    ["notes/a.txt", "notes/a.txt"],
    ["notes/a b?#%.txt", "notes/a%20b%3F%23%25.txt"],
  ])("empties a bucket containing %s after a failed test", async (key, encodedKey) => {
    let objects = [{ key }]
    let bucketDeletes = 0
    const { calls, fetch } = createFakeCloudflare(({ method, path }) => {
      if (path === "/r2/buckets") return ok({ buckets: [{ name: prefix }] })
      if (path === `/r2/buckets/${prefix}` && method === "DELETE") {
        bucketDeletes++
        return objects.length ? { status: 409, body: { success: false, errors: [{ code: 10008, message: "bucket not empty" }] } } : ok(null)
      }
      if (path === `/r2/buckets/${prefix}/objects`) return ok(objects)
      if (path === `/r2/buckets/${prefix}/objects/${encodedKey}`) {
        objects = []
        return ok(null)
      }
    })
    const { failures } = await teardownCloudflare({ accountId: "account", apiToken: "token", prefix, fetch, log: () => {} })

    expect(failures).toEqual([])
    expect(bucketDeletes).toBe(2)
    expect(deletes(calls)).toContain(`/r2/buckets/${prefix}/objects/${encodedKey}`)
  })

  it("follows container page tokens before deleting only this run's applications", async () => {
    const token = "next+/=page"
    const { calls, fetch } = createFakeCloudflare(({ method, path, query }) => {
      if (path === "/containers/applications") {
        return query.page_token === token
          ? ok([{ id: "app-1", name: `${prefix}-sandbox` }, { id: "app-2", name: `${prefix}4-sandbox` }])
          : ok([], { result_info: { next_page_token: token } })
      }
      if (method === "DELETE") return ok(null)
    })
    const { failures } = await teardownCloudflare({ accountId: "account", apiToken: "token", prefix, fetch, log: () => {} })

    expect(failures).toEqual([])
    expect(calls.filter(call => call.path === "/containers/applications").map(call => call.query)).toEqual([{}, { page_token: token }])
    expect(deletes(calls)).toContain("/containers/applications/app-1")
    expect(deletes(calls)).not.toContain("/containers/applications/app-2")
    expect(calls.slice(0, 3).map(call => [call.method, call.path])).toEqual([
      ["GET", "/containers/applications"],
      ["GET", "/containers/applications"],
      ["DELETE", "/containers/applications/app-1"],
    ])
  })

  it("keeps going after one kind fails and reports it", async () => {
    const { calls, fetch } = createFakeCloudflare(({ method, path }) => {
      if (path === "/queues" && method === "GET") return { status: 500, body: { success: false, errors: [{ code: 1, message: "boom" }] } }
      if (path === "/storage/kv/namespaces" && method === "GET") return ok([{ id: "kv-1", title: `${prefix}-kv` }])
      if (method === "DELETE" && path.startsWith("/storage/kv/")) return ok(null)
    })
    const { failures } = await teardownCloudflare({ accountId: "account", apiToken: "token", prefix, fetch, log: () => {} })

    expect(failures).toEqual(["queue: GET /queues failed: HTTP 500 (1 boom)"])
    expect(deletes(calls)).toContain("/storage/kv/namespaces/kv-1")
  })

  it.each(["", "vitehub-smoke-", "vitehub-playground-vite", "vitehub-smoke-12-extra"])("refuses the prefix %j", async (value) => {
    await expect(teardownCloudflare({ accountId: "account", apiToken: "token", prefix: value, fetch: () => { throw new Error("no request") }, log: () => {} }))
      .rejects.toThrow("Refusing to tear down")
  })

  it("skips without Cloudflare credentials", () => {
    const env: Record<string, string | undefined> = { ...process.env }
    delete env.CLOUDFLARE_ACCOUNT_ID
    delete env.CLOUDFLARE_API_TOKEN
    const result = spawnSync(process.execPath, [scriptPath, "--prefix", prefix], { encoding: "utf8", env })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("Skipping Cloudflare teardown")
  })
})

describe("live smoke workflow", () => {
  const workflow = parseYaml(readFileSync(resolve(repoRoot, ".github/workflows/live-smoke.yml"), "utf8"))
  const job = workflow.jobs["live-smoke"]
  const steps: Array<{ name?: string, if?: string, run?: string, env?: Record<string, string> }> = job.steps

  it("names Cloudflare resources after the run", () => {
    expect(job.env.LIVE_SMOKE_NAME).toBe("vitehub-smoke-${{ github.run_id }}")
    const naming = steps.find(step => step.name === "Name Cloudflare scratch resources")?.run ?? ""
    for (const variable of ["VITEHUB_CLOUDFLARE_WORKER_NAME", "VITEHUB_CLOUDFLARE_WORKFLOW_NAME", "VITEHUB_D1_DATABASE_NAME", "VITEHUB_D1_ANALYTICS_DATABASE_NAME", "VITEHUB_KV_NAMESPACE_NAME", "VITEHUB_QUEUE_NAME_PREFIX", "BLOB_BUCKET_NAME"]) {
      expect(naming).toMatch(new RegExp(`echo "${variable}=\\$LIVE_SMOKE_NAME`))
    }
    const text = readFileSync(resolve(repoRoot, ".github/workflows/live-smoke.yml"), "utf8")
    expect(text).not.toContain("CLOUDFLARE_KV_NAMESPACE_ID")
    expect(text).not.toContain("CLOUDFLARE_R2_BUCKET_NAME")
  })

  it("tears down after runtime tests, also on failure and cancel", () => {
    const teardownIndex = steps.findIndex(step => step.name === "Tear down Cloudflare scratch resources")
    const teardown = steps[teardownIndex]
    expect(steps[teardownIndex - 1]?.name).toBe("DB Live E2E")
    expect(teardown?.if).toBe("always() && matrix.provider == 'cloudflare'")
    expect(teardown?.run).toContain('--prefix "$LIVE_SMOKE_NAME"')
  })

  it("captures the job status after teardown before uploading provider evidence", () => {
    const teardownIndex = steps.findIndex(step => step.name === "Tear down Cloudflare scratch resources")
    expect(steps.slice(teardownIndex + 1).map(step => step.name)).toEqual(["Create stage evidence", "Upload stage evidence"])
    const evidence = steps[teardownIndex + 1]
    expect(evidence?.if).toBe("always()")
    expect(evidence?.env?.LIVE_SMOKE_CONCLUSION).toBe("${{ job.status }}")
    expect(evidence?.run).toContain('--conclusion "$LIVE_SMOKE_CONCLUSION"')
    expect(steps[teardownIndex + 2]?.if).toBe("always()")
  })
})
