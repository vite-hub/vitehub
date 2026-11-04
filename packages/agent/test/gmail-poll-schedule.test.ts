import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { build } from "esbuild"
import { expect, it, vi } from "vitest"
import { createNetlifyScheduleFunctionOutputs } from "../../schedule/src/internal/provider-output.ts"
import { hubAgent } from "../src/vite.ts"

it("polls from an isolated generated Netlify Schedule without loading a server plugin or webhook first", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-gmail-poll-schedule-"))
  const packageRoot = resolve(import.meta.dirname, "..")
  const output = join(packageRoot, "dist", `gmail-poll-schedule-${Date.now()}.mjs`)
  try {
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
    await mkdir(join(root, "server/agents"), { recursive: true })
    await mkdir(join(root, "server/schedules"), { recursive: true })
    await writeFile(join(root, "server/inbox.ts"), [
      "import { gmail } from '@vite-hub/agent/channels'",
      "globalThis.gmailPollCalls = []",
      "export const inbox = gmail({ client: async ({ path, query }) => {",
      "  globalThis.gmailPollCalls.push({ path, cursor: query?.startHistoryId })",
      "  if (path === 'profile') return { emailAddress: 'max@example.com', historyId: '300' }",
      "  if (path === 'history') return { historyId: '305', history: [] }",
      "  throw new Error('Unexpected Gmail request: ' + path)",
      "} })",
    ].join("\n"))
    await writeFile(join(root, "server/agents/poller.ts"), [
      "import { defineAgent } from '@vite-hub/agent'",
      "import { inbox } from '../inbox'",
      "export default defineAgent({ runtime: false, channels: { gmail: inbox }, driver: { run: () => 'ok' } })",
    ].join("\n"))
    const schedule = join(root, "server/schedules/mail.ts")
    await writeFile(schedule, [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "import { pollGmailChannel } from '@vite-hub/agent/channels'",
      "import { inbox } from '../inbox'",
      "export default defineSchedule({ cron: '*/5 * * * *', handler: async () => await pollGmailChannel(inbox) })",
    ].join("\n"))
    const plugin = hubAgent({ providers: { state: { provider: "libsql", url: `file:${join(root, "state.db")}` } } })
    if (typeof plugin.config !== "function") throw new Error("Expected config hook")
    const configured = await plugin.config.call({} as never, { root, nitro: {} } as never, { command: "build", mode: "production" })
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ root, command: "build", plugins: [], build: { outDir: "dist" }, resolve: { alias: [] }, createResolver: () => async (specifier: string) => fileURLToPath(import.meta.resolve(specifier)) })
    const aliases = (configured as { resolve: { alias: Record<string, string> } }).resolve.alias
    const registryFile = join(root, "schedules.mjs")
    await writeFile(registryFile, `export default { mail: () => import(${JSON.stringify(schedule)}) }`)
    const [entry] = await createNetlifyScheduleFunctionOutputs({ definitions: [{ name: "mail", handler: schedule }], functionRoot: root, registryFile })
    const input = join(root, "entry.mjs")
    await writeFile(input, entry!.source)
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
    await build({
      entryPoints: [input], outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", tsconfigRaw: { compilerOptions: {} },
      plugins: [{ name: "generated-agent-runtime", setup(builder) {
        builder.onResolve({ filter: /^#vitehub\/agent\/registry$/ }, () => ({ path: aliases["#vitehub/agent/registry"]! }))
        builder.onResolve({ filter: /^@vite-hub\/agent(?:\/|$)/ }, args => ({ path: join(packageRoot, manifest.exports[args.path === "@vite-hub/agent" ? "." : `.${args.path.slice("@vite-hub/agent".length)}`].import) }))
      } }],
    })
    const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", [
      "const mod = await import(process.argv[1])",
      "for (let i = 0; i < 3; i++) { const response = await mod.default(new Request('https://mail.example.com/schedule')); if (response.status !== 204) throw new Error('Schedule failed: ' + response.status) }",
      "console.log(JSON.stringify(globalThis.gmailPollCalls))",
    ].join("\n"), pathToFileURL(output).href])
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toEqual([
      { path: "profile" }, { path: "history", cursor: "300" }, { path: "history", cursor: "305" },
    ])
  }
  finally {
    await rm(output, { force: true })
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it("installs the Deno polling host before importing cron registrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-gmail-poll-deno-"))
  const packageRoot = resolve(import.meta.dirname, "..")
  const output = join(packageRoot, "dist", `gmail-poll-deno-${Date.now()}.mjs`)
  try {
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
    await mkdir(join(root, "server/agents"), { recursive: true })
    await mkdir(join(root, ".vitehub/schedule"), { recursive: true })
    await writeFile(join(root, "server/inbox.ts"), [
      "import { gmail } from '@vite-hub/agent/channels'",
      "export const inbox = gmail({ client: async ({ path }) => {",
      "  if (path !== 'profile') throw new Error('Unexpected Gmail request: ' + path)",
      "  globalThis.gmailPollCalls = (globalThis.gmailPollCalls || 0) + 1",
      "  return { emailAddress: 'max@example.com', historyId: '300' }",
      "} })",
    ].join("\n"))
    await writeFile(join(root, "server/agents/poller.ts"), [
      "import { defineAgent } from '@vite-hub/agent'",
      "import { inbox } from '../inbox'",
      "export default defineAgent({ runtime: false, channels: { gmail: inbox }, driver: { run: () => 'ok' } })",
    ].join("\n"))
    await writeFile(join(root, ".vitehub/schedule/deno-cron.mjs"), [
      "import { pollGmailChannel } from '@vite-hub/agent/channels'",
      "import { inbox } from '../../server/inbox'",
      "Deno.cron('mail', '*/5 * * * *', () => pollGmailChannel(inbox))",
      "await globalThis.gmailPollCron()",
    ].join("\n"))
    const plugin = hubAgent({ runtime: "deno", providers: { state: { provider: "libsql", url: `file:${join(root, "state.db")}` } } })
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ root, command: "build", plugins: [], resolve: { alias: [] } })
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
    await build({
      entryPoints: [join(root, ".vitehub/agent/deno-server.ts")], outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", tsconfigRaw: { compilerOptions: {} },
      plugins: [{ name: "generated-agent-runtime", setup(builder) {
        builder.onResolve({ filter: /^#vitehub\/agent\/registry$/ }, () => ({ path: join(root, ".vitehub/agent/registry.mjs") }))
        builder.onResolve({ filter: /^@vite-hub\/agent(?:\/|$)/ }, args => ({ path: join(packageRoot, manifest.exports[args.path === "@vite-hub/agent" ? "." : `.${args.path.slice("@vite-hub/agent".length)}`].import) }))
      } }],
    })
    const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", [
      "globalThis.Deno = { args: [], cron: (_name, _cron, callback) => { globalThis.gmailPollCron = callback }, serve: () => ({ finished: Promise.resolve() }) }",
      "await import(process.argv[1])",
      "console.log(globalThis.gmailPollCalls)",
    ].join("\n"), pathToFileURL(output).href])
    expect(result.stdout.trim().split("\n").at(-1)).toBe("1")
  }
  finally {
    await rm(output, { force: true })
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it("bundles the Channel host from the retained Netlify Agent registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-gmail-poll-netlify-output-"))
  try {
    vi.stubEnv("VITEHUB_HOSTING", "netlify")
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
    await mkdir(join(root, "server/agents"), { recursive: true })
    await writeFile(join(root, "server/agents/poller.ts"), "export default {}\n")
    const plugin = hubAgent({ providers: { state: { provider: "libsql", url: "libsql://state.example.com" } } })
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ root, command: "build", plugins: [], build: { outDir: "dist" }, resolve: { alias: [] } })
    await (plugin.buildEnd as () => Promise<void>)()
    await (plugin.closeBundle as { handler: () => Promise<void> }).handler()
    await expect(readFile(join(root, ".netlify/v1/functions/vitehub-agent.mjs"), "utf8")).resolves.not.toHaveLength(0)
  }
  finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it("installs configured workspace dependency loaders in the retained polling host", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-gmail-poll-loaders-"))
  try {
    vi.stubEnv("VITEHUB_HOSTING", "netlify")
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
    await mkdir(join(root, "server/agents"), { recursive: true })
    await writeFile(join(root, "server/agents/poller.ts"), "export default {}\n")
    // SAFETY: Framework integrations supply these internal import options to hubAgent.
    const plugin = hubAgent({
      providers: { state: { provider: "libsql", url: "libsql://state.example.com" } },
      workspaceDependencyRuntimeImports: {
        sandboxTask: "vite-hub/sandbox/task",
        sandboxTaskRuntimeState: "vite-hub/_internal/sandbox/task/runtime/state",
        shellWorkspace: "vite-hub/shell/workspace",
      },
    } as never)
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ root, command: "build", plugins: [], build: { outDir: "dist" }, resolve: { alias: [] } })
    await (plugin.buildEnd as () => Promise<void>)()
    const generations = join(root, ".vitehub/agent-generations")
    const directories = [generations]
    const handlers: string[] = []
    for (const directory of directories) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory() && entry.name !== "node_modules") directories.push(path)
        if (entry.isFile() && path.replaceAll("\\", "/").endsWith("/.vitehub/agent/chat-webhook-route.ts")) handlers.push(path)
      }
    }
    expect(handlers).toHaveLength(1)
    const handler = await readFile(handlers[0]!, "utf8")
    expect(handler).toContain("vitehubSetWorkspaceDependencyRuntimeLoaders({")
    expect(handler).toContain('sandboxTask: () => import("vite-hub/sandbox/task")')
    expect(handler).toContain('sandboxTaskRuntimeState: () => import("vite-hub/_internal/sandbox/task/runtime/state")')
    expect(handler).toContain('shellWorkspace: () => import("vite-hub/shell/workspace")')
  }
  finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
