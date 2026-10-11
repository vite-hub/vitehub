import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createQueueProvisionStep } from "../src/provision.ts"
import { getCloudflareQueueName } from "../src/internal/cloudflare-resource-name.ts"

import type { ProvisionContext } from "@vite-hub/internal/provision"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function createTempDir() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-queue-provision-"))
  directories.push(rootDir)
  return rootDir
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
}

function provisionContext(fetchImpl: typeof globalThis.fetch): ProvisionContext {
  return {
    env: { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "token" },
    fetch: fetchImpl,
    logger: { log: () => {}, warn: () => {} },
  }
}

const sparseQueueList: unknown[] = []
sparseQueueList.length = 1

describe("queue provision step", () => {
  it("does not create a queue that already exists", async () => {
    const rootDir = await createTempDir()
    await writeFile(join(rootDir, "welcome.queue.ts"), "export default null\n", "utf8")
    const existing = getCloudflareQueueName("welcome")

    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (!init || init.method !== "POST") return jsonResponse({ success: true, result: [{ queue_name: existing }] })
      throw new Error("must not create existing queue")
    }) as unknown as typeof globalThis.fetch

    const actions = await createQueueProvisionStep(() => rootDir).plan(provisionContext(fetchImpl))
    expect(actions).toHaveLength(1)
    expect(actions[0]!.exists).toBe(true)

    await actions[0]!.apply()
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false)
  })

  it("creates a missing queue with the hex-encoded name", async () => {
    const rootDir = await createTempDir()
    await writeFile(join(rootDir, "welcome.queue.ts"), "export default null\n", "utf8")
    const expectedName = getCloudflareQueueName("welcome")

    const posted: unknown[] = []
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)))
        return jsonResponse({ success: true, result: { queue_name: expectedName } })
      }
      return jsonResponse({ success: true, result: [] })
    }) as unknown as typeof globalThis.fetch

    const actions = await createQueueProvisionStep(() => rootDir).plan(provisionContext(fetchImpl))
    expect(actions[0]!.exists).toBe(false)
    await actions[0]!.apply()
    expect(posted).toEqual([{ queue_name: expectedName }])
  })

  it.each([
    [null],
    ["welcome"],
  ])("rejects malformed Cloudflare queue entries: %s", async (result) => {
    const rootDir = await createTempDir()
    await writeFile(join(rootDir, "welcome.queue.ts"), "export default null\n", "utf8")
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true, result })) as unknown as typeof globalThis.fetch

    await expect(createQueueProvisionStep(() => rootDir).plan(provisionContext(fetchImpl)))
      .rejects.toMatchObject({ code: "QUEUE_R0011" })
  })

  it("rejects sparse Cloudflare queue lists before JSON serialization", async () => {
    const rootDir = await createTempDir()
    await writeFile(join(rootDir, "welcome.queue.ts"), "export default null\n", "utf8")
    const response = new Response()
    const json = vi.spyOn(response, "json").mockResolvedValue({ success: true, result: sparseQueueList })
    const fetchImpl: typeof globalThis.fetch = async () => response

    await expect(createQueueProvisionStep(() => rootDir).plan(provisionContext(fetchImpl)))
      .rejects.toMatchObject({ code: "QUEUE_R0011" })
    expect(json).toHaveBeenCalledOnce()
    expect(Object.hasOwn(sparseQueueList, 0)).toBe(false)
  })

  it("provisions the same prefixed physical queue name used by deployment output", async () => {
    const rootDir = await createTempDir()
    await writeFile(join(rootDir, "welcome.queue.ts"), "export default null\n", "utf8")
    const expectedName = getCloudflareQueueName("welcome", "preview-")

    const posted: unknown[] = []
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)))
        return jsonResponse({ success: true, result: { queue_name: expectedName } })
      }
      return jsonResponse({ success: true, result: [] })
    }) as unknown as typeof globalThis.fetch

    const actions = await createQueueProvisionStep(() => rootDir, () => "preview-").plan(provisionContext(fetchImpl))
    expect(actions[0]!.name).toBe(expectedName)
    await actions[0]!.apply()
    expect(posted).toEqual([{ queue_name: expectedName }])
  })

  it("reuses the legacy readable Queue when the encoded deployment name is too long", async () => {
    const rootDir = await createTempDir()
    await writeFile(join(rootDir, "image-optimization.queue.ts"), "export default null\n", "utf8")
    const namePrefix = "vitehub-drop-pm-20260719-"
    const existing = "vitehub-drop-pm-20260719-image-optimization"

    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (!init || init.method !== "POST") return jsonResponse({ success: true, result: [{ queue_name: existing }] })
      throw new Error("must not create a replacement queue")
    }) as unknown as typeof globalThis.fetch

    const actions = await createQueueProvisionStep(() => rootDir, () => namePrefix).plan(provisionContext(fetchImpl))
    expect(actions).toMatchObject([{ exists: true, name: existing }])

    await actions[0]!.apply()
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false)
  })

  it("skips when Cloudflare credentials are missing", async () => {
    const rootDir = await createTempDir()
    await writeFile(join(rootDir, "welcome.queue.ts"), "export default null\n", "utf8")
    const warn = vi.fn()
    const actions = await createQueueProvisionStep(() => rootDir).plan({
      env: {},
      fetch: globalThis.fetch,
      logger: { log: () => {}, warn },
    })
    expect(actions).toEqual([])
    expect(warn).toHaveBeenCalled()
  })
})
