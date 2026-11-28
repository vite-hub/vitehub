import { spawn } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"

import { array, object, parse, picklist, string } from "valibot"

import { createVercelBridge } from "../local/vercel-bridge.mjs"
import { repoRoot, run, stopProcessGroup } from "../consumer/packed-app.ts"

export const templatesRoot = join(repoRoot, "templates/nuxt")
export const modes = ["dev", "docker", "cloudflare", "vercel", "url"] as const
export type Mode = typeof modes[number]

const manifestSchema = object({ description: string(), primitives: array(string()), title: string() })

export const templates = readdirSync(templatesRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map((entry) => {
    const dir = join(templatesRoot, entry.name)
    return { dir, name: entry.name, ...parse(manifestSchema, JSON.parse(readFileSync(join(dir, "template.json"), "utf8"))) }
  })
  .sort((left, right) => left.name.localeCompare(right.name))

export type Template = typeof templates[number]

const requested = process.env.VITEHUB_TEMPLATE?.split(",").filter(Boolean) ?? []
for (const name of requested) {
  if (!templates.some(template => template.name === name)) throw new Error(`Unknown template "${name}". Use one of: ${templates.map(template => template.name).join(", ")}.`)
}
export const selectedTemplates = templates.filter(template => requested.length === 0 || requested.includes(template.name))
export const selectedMode: Mode = parse(picklist(modes), process.env.VITEHUB_TEMPLATE_MODE || "dev")

const ports: Record<string, number> = { agent: 29642, dashboard: 29641, jobs: 29643 }

async function portIsFree(port: number) {
  const server = createServer()
  const free = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => resolve(true))
  })
  if (free) await new Promise(resolve => server.close(resolve))
  return free
}

async function waitForFreePort(port: number) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await portIsFree(port)) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Port ${port} is in use. Stop the process that holds it, or pass --port.`)
}

export function nuxt(template: Template, args: string[], preset?: string) {
  return run(join(template.dir, "node_modules/.bin/nuxt"), args, template.dir, {
    ...process.env,
    NUXT_TELEMETRY_DISABLED: "1",
    ...(preset ? { NITRO_PRESET: preset } : {}),
  })
}

function spawnServer(command: string, args: string[], cwd: string) {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    env: { ...process.env, NO_COLOR: "1", NUXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let logs = ""
  child.stdout.on("data", chunk => { logs += String(chunk) })
  child.stderr.on("data", chunk => { logs += String(chunk) })
  return {
    exited: () => child.exitCode !== null,
    logs: () => logs,
    stop: () => stopProcessGroup(child.pid!),
  }
}

async function waitForOrigin(origin: string, server: { exited: () => boolean, logs: () => string }) {
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    if (server.exited()) throw new Error(`The server exited before it served ${origin}.\n${server.logs()}`)
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(30_000) })
      if (response.status < 500) return
    }
    catch {
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  throw new Error(`${origin} did not answer in 5 minutes.\n${server.logs()}`)
}

export interface TemplateServer {
  logs: () => string
  origin: string
  stop: () => Promise<void>
}

export async function startTemplate(template: Template, mode: Mode): Promise<TemplateServer> {
  if (mode === "url") {
    const url = process.env.VITEHUB_TEMPLATE_URL
    if (!url) throw new Error("Mode url needs VITEHUB_TEMPLATE_URL, for example --url https://my-app.example.com.")
    return { logs: () => "", origin: url.replace(/\/$/, ""), stop: async () => {} }
  }

  const port = Number(process.env.VITEHUB_TEMPLATE_PORT) || ports[template.name] || 29644
  await waitForFreePort(port)
  const origin = `http://127.0.0.1:${port}`

  if (mode === "vercel") {
    await nuxt(template, ["build"], "vercel")
    const bridge = await createVercelBridge({ outputDir: join(template.dir, ".vercel/output"), port })
    return { logs: () => "", origin, stop: () => bridge.close() }
  }

  let server: ReturnType<typeof spawnServer>
  if (mode === "dev") {
    server = spawnServer(join(template.dir, "node_modules/.bin/nuxt"), ["dev", "--no-fork", "--host", "127.0.0.1", "--port", String(port)], template.dir)
  }
  else if (mode === "cloudflare") {
    await nuxt(template, ["build"], "cloudflare_module")
    server = spawnServer(join(repoRoot, "node_modules/.bin/wrangler"), ["dev", "--config", ".output/server/wrangler.json", "--persist-to", ".wrangler/state", "--ip", "127.0.0.1", "--port", String(port), "--local", "--show-interactive-dev-session=false"], template.dir)
  }
  else {
    const image = `vitehub-template-${template.name}:test`
    const container = `vitehub-template-${template.name}-${port}`
    await nuxt(template, ["build"], "node-server")
    await run("docker", ["build", "--tag", image, template.dir], template.dir)
    const docker = spawnServer("docker", ["run", "--rm", "--name", container, "--publish", `127.0.0.1:${port}:3000`, image], template.dir)
    server = { ...docker, stop: async () => {
      await run("docker", ["rm", "--force", container], template.dir).catch(() => undefined)
      await docker.stop()
      await waitForFreePort(port)
    } }
  }

  try {
    await waitForOrigin(origin, server)
  }
  catch (error) {
    await server.stop()
    throw error
  }
  return { logs: server.logs, origin, stop: server.stop }
}
