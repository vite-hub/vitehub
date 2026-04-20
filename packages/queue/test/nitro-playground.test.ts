import { readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { build, createNitro, prepare } from "nitro/builder"

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../../../playground/nitro")
const workspaceRoot = resolve(playgroundDir, "../..")
const testBuildDir = join(playgroundDir, "node_modules", ".nitro-playground-test")
const testOutputDir = join(playgroundDir, ".queue-playground-output")

async function buildQueuePackage() {
  await execFileAsync("pnpm", ["--filter", "@vitehub/queue", "build"], {
    cwd: workspaceRoot,
    env: process.env,
  })
}

async function buildPlayground() {
  const nitro = await createNitro({
    buildDir: testBuildDir,
    output: {
      dir: testOutputDir,
    },
    preset: "cloudflare_module",
    rootDir: playgroundDir,
  })
  await prepare(nitro)
  await build(nitro)
  const output = {
    outputDir: testOutputDir,
  }
  await nitro.close()
  return output
}

async function cleanupPlayground() {
  await rm(testBuildDir, { force: true, recursive: true, maxRetries: 10, retryDelay: 50 })
  await rm(testOutputDir, { force: true, recursive: true, maxRetries: 10, retryDelay: 50 })
}

beforeAll(async () => {
  await cleanupPlayground()
})

afterAll(async () => {
  await cleanupPlayground()
})

describe("Nitro playground", () => {
  it("serves the queue routes and discovers server/queues handlers", async () => {
    await buildQueuePackage()
    const { outputDir } = await buildPlayground()

    const send = vi.fn(async () => {})
    const sendBatch = vi.fn(async () => {})
    const nitroJson = JSON.parse(await readFile(join(outputDir, "nitro.json"), "utf8"))
    const serverEntry = join(outputDir, nitroJson.serverEntry)
    const workerModule = await import(serverEntry)
    const pending: Promise<unknown>[] = []
    const context = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise)
      },
    }
    const env = {
      QUEUE_77656C636F6D65: {
        send,
        sendBatch,
      },
    }

    const indexResponse = await workerModule.default.fetch(new Request("http://localhost/"), env, context)
    expect(await indexResponse.json()).toEqual({
      ok: true,
      queue: "welcome",
    })

    const directResponse = await workerModule.default.fetch(new Request("http://localhost/api/queues/welcome", {
      body: JSON.stringify({ email: "ava@example.com", marker: "nitro-direct" }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    }), env, context)
    const pendingBeforeDefer = pending.length
    expect(await directResponse.json()).toEqual({
      ok: true,
      result: {
        messageId: expect.any(String),
        status: "queued",
      },
    })

    const deferResponse = await workerModule.default.fetch(new Request("http://localhost/api/queues/welcome-defer", {
      body: JSON.stringify({ email: "ava@example.com", marker: "nitro-defer" }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    }), env, context)
    expect(await deferResponse.json()).toEqual({ ok: true })

    expect(pending.length).toBeGreaterThan(pendingBeforeDefer)
    await pending.at(-1)
    expect(send).toHaveBeenCalledTimes(2)
    expect(sendBatch).not.toHaveBeenCalled()
  }, 30_000)
})
