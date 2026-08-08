import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { expect, it } from "vitest"

import { syncPackedWorkspaceDependencies } from "../../internal/test-utils/published-types.js"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, "..")
const workspaceRoot = resolve(packageRoot, "../..")
const packedPackages = ["agent", "box", "history", "markdown-template", "rate-limit", "runtime", "source", "workflow", "workspace"] as const

async function runPnpm(args: string[], cwd: string): Promise<void> {
  const npmExecPath = process.env.npm_execpath
  const command = npmExecPath?.includes("pnpm") ? process.execPath : "corepack"
  const commandArgs = npmExecPath?.includes("pnpm") ? [npmExecPath, ...args] : ["pnpm", ...args]
  await execFileAsync(command, commandArgs, {
    cwd,
    env: { ...process.env, CI: "true" },
    killSignal: "SIGKILL",
    timeout: 60_000,
  })
}

async function availablePort(): Promise<number> {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port")
  await new Promise<void>((resolveClose, reject) => server.close(error => (error ? reject(error) : resolveClose())))
  return address.port
}

async function requestWhenReady(url: string): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await fetch(url)
    } catch (error) {
      lastError = error
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    }
  }
  throw lastError
}

async function waitForFile(path: string, value: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (
      await readFile(path, "utf8")
        .catch(() => "")
        .then(contents => contents.includes(value))
    )
      return
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(value)} in ${path}`)
}

it("stops a packed Agent webhook queue through Nitro 3 Node shutdown", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-nitro-shutdown-"))
  const statePath = join(root, "state.sqlite")
  const proofPath = join(root, "queue-proof.log")
  let child: ReturnType<typeof spawn> | undefined
  try {
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify(
        {
          dependencies: {
            ...Object.fromEntries(packedPackages.map(name => [`@vite-hub/${name}`, "workspace:*"])),
            h3: "2.0.1-rc.25",
            nitro: "3.0.260603-beta",
            vite: "8.1.5",
          },
          packageManager: "pnpm@10.33.0",
          private: true,
          type: "module",
        },
        null,
        2,
      )}\n`,
      "utf8",
    )
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - .\n", "utf8")
    await writeFile(
      join(root, "server", "agents", "review.ts"),
      `
import { appendFile } from "node:fs/promises"
import { defineAgent } from "@vite-hub/agent"
import { github } from "@vite-hub/agent/channels"

export default defineAgent({
  channels: {
    github: github({
      triggers: {
        webhook: {
          invoke: (_context, input) => ({
            input: { prompt: "shutdown", proofPath: process.env.VITEHUB_QUEUE_PROOF },
            webhook: {
              concurrencyLimit: 1,
              deliveryId: input.github.deliveryId,
            },
          }),
        },
      },
      webhooks: { secretToken: false },
    }),
  },
  driver: {
    async run({ input }) {
      const signal = input.abortSignal
      await appendFile(input.proofPath, "started\\n")
      try {
        await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
      }
      finally {
        await appendFile(input.proofPath, "aborted:" + signal.aborted + "\\n")
        await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
      }
    },
  },
})
`,
      "utf8",
    )
    await writeFile(
      join(root, "listeners.ts"),
      `
import { defineEventHandler } from "h3"

export default defineEventHandler(() => ({
  sigterm: process.listeners("SIGTERM").map(listener => listener.name),
}))
`,
      "utf8",
    )
    await writeFile(
      join(root, "build.mjs"),
      `
import { build, copyPublicAssets, createNitro, prepare } from "nitro/builder"
import { join } from "node:path"
import { resolveConfig } from "vite"
import { hubAgent } from "@vite-hub/agent/vite"

const root = process.cwd()
const config = await resolveConfig({
  root,
  plugins: [hubAgent({ providers: { state: { provider: "sqlite", url: ${JSON.stringify(`file:${statePath}`)} } } })],
}, "build")
const nitro = await createNitro({
  ...config.nitro,
  dev: false,
  handlers: [...(config.nitro.handlers || []), { handler: join(root, "listeners.ts"), route: "/listeners" }],
  preset: "node-server",
  rootDir: root,
})
try {
  await prepare(nitro)
  await copyPublicAssets(nitro)
  await build(nitro)
}
finally {
  await nitro.close()
}
`,
      "utf8",
    )

    await syncPackedWorkspaceDependencies(
      root,
      workspaceRoot,
      packedPackages.map(name => `@vite-hub/${name}`),
    )
    await Promise.all(packedPackages.map(name => runPnpm(["pack", "--pack-destination", root], join(workspaceRoot, "packages", name))))
    await runPnpm(["install", "--prefer-offline", "--ignore-scripts", "--no-frozen-lockfile"], root)
    await runPnpm(["exec", "node", "build.mjs"], root)

    const unownedPort = await availablePort()
    child = spawn(process.execPath, [join(root, ".output", "server", "index.mjs")], {
      cwd: root,
      env: { ...process.env, CI: "true", NITRO_PORT: String(unownedPort), TEST: undefined, VITEHUB_QUEUE_PROOF: proofPath },
      stdio: ["ignore", "ignore", "pipe"],
    })
    let unownedStderr = ""
    child.stderr!.setEncoding("utf8")
    child.stderr!.on("data", chunk => (unownedStderr += chunk))
    const unownedExited = once(child, "exit")
    const unownedListeners = await Promise.race([
      requestWhenReady(`http://127.0.0.1:${unownedPort}/listeners`).then(response => response.json()) as Promise<{ sigterm: string[] }>,
      unownedExited.then(exit => {
        throw new Error(`Nitro child exited before serving (${exit.join(", ")}):\n${unownedStderr}`)
      }),
    ])
    expect(unownedListeners.sigterm).toEqual([])
    child.kill("SIGTERM")
    await expect(unownedExited).resolves.toEqual([null, "SIGTERM"])
    child = undefined

    const port = await availablePort()
    child = spawn(process.execPath, [join(root, ".output", "server", "index.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        CI: undefined,
        NITRO_PORT: String(port),
        TEST: undefined,
        VITEHUB_QUEUE_PROOF: proofPath,
      },
      stdio: ["ignore", "ignore", "pipe"],
    })
    let stderr = ""
    child.stderr!.setEncoding("utf8")
    child.stderr!.on("data", chunk => (stderr += chunk))
    const exited = once(child, "exit")
    await requestWhenReady(`http://127.0.0.1:${port}/listeners`)
    const webhook = await fetch(`http://127.0.0.1:${port}/api/_vitehub/agents/review/webhooks/github`, {
      body: "{}",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "shutdown-delivery",
        "x-github-event": "pull_request",
      },
      method: "POST",
    })
    expect(webhook.status, `${await webhook.clone().text()}\n${stderr}`).toBe(200)
    await expect(webhook.clone().json()).resolves.toMatchObject({ accepted: true, queued: true })
    await waitForFile(proofPath, "started").catch(error => {
      throw new Error(`${error}\n${stderr}`)
    })
    const listeners = await fetch(`http://127.0.0.1:${port}/listeners`).then(response => response.json()) as { sigterm: string[] }

    child.kill("SIGTERM")
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    const exit = await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`Nitro child did not stop after SIGTERM:\n${stderr}`)), 4_000)),
    ])

    expect(listeners).toMatchObject({ sigterm: expect.any(Array) })
    expect(listeners.sigterm.slice(0, 2)).toEqual(["shutdownWebhookQueues", "shutdown"])
    expect(exit).toEqual([0, null])
    await expect(readFile(proofPath, "utf8")).resolves.toContain("aborted:true")

    const state = createLibsqlAgentState({ url: `file:${statePath}` })
    try {
      await state.connect()
      await expect(state.claimWebhookDelivery("webhook:review:github:github:")).resolves.toMatchObject({
        deliveryId: "shutdown-delivery",
      })
    } finally {
      await state.disconnect()
    }
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL")
      await once(child, "exit").catch(() => undefined)
    }
    await rm(root, { force: true, recursive: true })
  }
})
