// The page bridge from end to end, under the server's rules: a Vue page runs ui-sdk's `createAgent()` through
// `connectPage()`, `useChat(agent, { page })` names it, and a ViteHub Agent with a scripted model works the page over
// Realtime. The Agent's `page()` Capability denies one field and makes two others need the person's approval. The check
// builds the same app with Vite and with Nuxt 5, for Node and for Cloudflare (workerd through Miniflare), signs two
// people in with ViteHub Auth, opens the app in headless Chromium, and checks:
// - the N1 settings task (vite-hub/nuxt-evals tasks/vitehub-ui/operate), with the save approved by the person;
// - a denied step, by the component's ref id, returns AGENT_R1047 and changes nothing;
// - two steps that need approval in one call: the person approves one and refuses the other (AGENT_R1049);
// - `vitehub agent invocations show` lists every change with Agent, page, person, step, before, after and time;
// - undo from the page, and undo by an operator with `vitehub invocations undo`;
// - a second person who joins the first person's page id gets no calls, and their run cannot reach that page.
// Run: pnpm --filter vite-hub test:browser   (AGENT_PAGE_CASES=vite-node,nuxt-cloudflare picks cases)
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { createConsoleKeyPair } from "@vite-hub/internal/console-signature"
import { chromium } from "playwright-core"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const fixtures = join(packageRoot, ".cache/agent-page")
const cli = join(packageRoot, "dist/bin.js")
const run = promisify(execFile)
const prompts = {
  settings: "Set the default region to Frankfurt, make the project visible to the whole team, and turn off the email I get when a deploy fails. Leave everything else as it is, and save.",
  rename: "Rename the project to Hacked.",
  digest: "Turn on the weekly digest and save.",
  read: "Read the page.",
}
const initialSettings = {
  name: "Atlas",
  description: "The marketing site and its preview deployments.",
  region: "iad",
  visibility: "private",
  autoDeploy: true,
  previews: true,
  emailOnFailure: true,
  weeklyDigest: false,
  slackAlerts: true,
}
const expectedSettings = { ...initialSettings, region: "fra", visibility: "team", emailOnFailure: false }
const secret = "agent-page-browser-check-secret-0123456789abcdef"

// The scripted model. It picks its script by the last prompt, and its step by the tool results after that prompt, so
// one model serves every run of every person. The rename script reads the ref id of "Project name" from its snapshot,
// as a model does, so a rule on the label must hold for a step that names the ref.
const agentFile = `import { simulateReadableStream } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { defineAgent } from "vite-hub/agent"
import { page } from "vite-hub/agent/capabilities"
import { webChat } from "vite-hub/agent/channels"
import { authenticated } from "vite-hub/auth/agent"

const prompts = ${JSON.stringify(prompts)}
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }
function reply(chunks) {
  return { stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] }, ...chunks] }) }
}
function toolCall(id, toolName, input) {
  return reply([
    { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
  ])
}
function text(value) {
  return reply([
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: value },
    { type: "text-end", id: "text-1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ])
}
function lastToolOutput(results) {
  const output = results.at(-1)?.output
  return output?.type === "json" ? output.value : output?.value
}
const scripts = {
  [prompts.settings]: [
    () => toolCall("settings-1", "page_snapshot", {}),
    () => toolCall("settings-2", "page_act", { steps: [
      { ref: "Default region", action: "setValue", args: ["Frankfurt (eu-central-1)"] },
      { ref: "Visibility", action: "setValue", args: ["Team"] },
      { ref: "Email me when a deploy fails", action: "setChecked", args: [false] },
    ] }),
    () => toolCall("settings-3", "page_act", { steps: [{ ref: "Save changes", action: "press" }] }),
    () => text("Saved: Frankfurt, Team, and no email on failed deploys."),
  ],
  [prompts.rename]: [
    () => toolCall("rename-1", "page_snapshot", {}),
    (results) => {
      const snapshot = lastToolOutput(results)
      const field = Array.isArray(snapshot) ? snapshot.find(component => component.label === "Project name") : undefined
      return toolCall("rename-2", "page_act", { steps: [{ ref: field?.ref ?? "Project name", action: "setValue", args: ["Hacked"] }] })
    },
    () => text("I could not rename it."),
  ],
  [prompts.digest]: [
    () => toolCall("digest-1", "page_act", { steps: [
      { ref: "Weekly digest", action: "setChecked", args: [true] },
      { ref: "Save changes", action: "press" },
    ] }),
    () => text("The digest is on. You did not let me save."),
  ],
  [prompts.read]: [
    () => toolCall("read-1", "page_snapshot", {}),
    () => text("Done."),
  ],
}

const model = new MockLanguageModelV3({
  doStream: async ({ prompt }) => {
    const last = prompt.findLastIndex(message => message.role === "user")
    const said = (prompt[last]?.content ?? []).filter(part => part.type === "text").map(part => part.text).join("")
    const script = Object.entries(scripts).find(([key]) => said.includes(key))?.[1]
    if (!script) return text("I have no script for that.")
    const results = prompt.slice(last + 1).filter(message => message.role === "tool").flatMap(message => message.content).filter(part => part.type === "tool-result")
    return script[Math.min(results.length, script.length - 1)](results)
  },
})

export default defineAgent({
  invoker: authenticated(),
  capabilities: [page({
    deny: [{ label: "Project name" }],
    requireApproval: [{ label: "Save changes" }, { label: "Weekly digest" }],
  })],
  channels: { web: webChat() },
  driver: { model },
})
`

const authFile = `import { defineAuth } from "vite-hub/auth"

export default defineAuth({
  appName: "Acme",
  emailAndPassword: { enabled: true },
})
`

const stateFile = `const initial = ${JSON.stringify(initialSettings)}
const scope = globalThis
scope.__settingsState ??= { settings: { ...initial }, saves: [] }
export const state = scope.__settingsState
`
const settingsGet = `import { defineEventHandler } from "h3"
import { state } from "../state"
export default defineEventHandler(() => state.settings)
`
const settingsPut = `import { defineEventHandler, readBody } from "h3"
import { state } from "../state"
export default defineEventHandler(async (event) => {
  const next = await readBody(event)
  state.settings = { ...state.settings, ...next }
  state.saves.push(next)
  return state.settings
})
`
const savesGet = `import { defineEventHandler } from "h3"
import { state } from "../state"
export default defineEventHandler(() => state.saves)
`

// The N1 settings page, as nuxt-evals tasks/vitehub-ui/operate/app/src/ProjectSettings.vue has it.
const settingsPage = `<script setup lang="ts">
import { Button } from "@ui-sdk/vue/button"
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/vue/field"
import { Input } from "@ui-sdk/vue/input"
import { Radio, RadioGroup, RadioIndicator } from "@ui-sdk/vue/radio"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui-sdk/vue/select"
import { Switch, SwitchThumb } from "@ui-sdk/vue/switch"
import { Textarea } from "@ui-sdk/vue/textarea"
import { onMounted, ref } from "vue"

const regions = [
  { value: "iad", label: "Virginia (us-east-1)" },
  { value: "pdx", label: "Oregon (us-west-2)" },
  { value: "yul", label: "Montreal (ca-central-1)" },
  { value: "gru", label: "São Paulo (sa-east-1)" },
  { value: "dub", label: "Dublin (eu-west-1)" },
  { value: "lhr", label: "London (eu-west-2)" },
  { value: "cdg", label: "Paris (eu-west-3)" },
  { value: "fra", label: "Frankfurt (eu-central-1)" },
  { value: "arn", label: "Stockholm (eu-north-1)" },
  { value: "bom", label: "Mumbai (ap-south-1)" },
  { value: "sin", label: "Singapore (ap-southeast-1)" },
  { value: "nrt", label: "Tokyo (ap-northeast-1)" },
]
const visibilities = [
  { value: "private", label: "Private", description: "Only you" },
  { value: "team", label: "Team", description: "Everyone in Acme" },
  { value: "public", label: "Public", description: "Anyone with the link" },
]
const members = [
  { name: "Ada Lovelace", email: "ada@acme.dev", role: "Owner" },
  { name: "Grace Hopper", email: "grace@acme.dev", role: "Admin" },
  { name: "Alan Turing", email: "alan@acme.dev", role: "Developer" },
  { name: "Edsger Dijkstra", email: "edsger@acme.dev", role: "Viewer" },
]

const settings = ref()
const status = ref("")

onMounted(async () => {
  settings.value = await (await fetch("/api/settings")).json()
})

async function save() {
  status.value = ""
  const response = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings.value) })
  status.value = response.ok ? "Saved" : "Could not save"
}
</script>

<template>
  <h1>Project settings · Atlas</h1>
  <form v-if="settings" @submit.prevent="save">
    <section>
      <h2>General</h2>
      <Field>
        <FieldLabel>Project name</FieldLabel>
        <Input v-model:value="settings.name" />
      </Field>
      <Field>
        <FieldLabel>Description</FieldLabel>
        <Textarea v-model:value="settings.description" />
      </Field>
      <Field>
        <FieldLabel>Default region</FieldLabel>
        <FieldDescription>New deployments run here.</FieldDescription>
        <Select v-model:value="settings.region" :items="regions">
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="region in regions" :key="region.value" :value="region.value">{{ region.label }}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </section>
    <section>
      <h2>Deployments</h2>
      <Field>
        <FieldLabel>Visibility</FieldLabel>
        <RadioGroup v-model:value="settings.visibility">
          <div v-for="option in visibilities" :key="option.value">
            <label data-slot="label">
              <Radio :value="option.value">
                <RadioIndicator />
              </Radio>
              {{ option.label }}
            </label>
            <small>{{ option.description }}</small>
          </div>
        </RadioGroup>
      </Field>
      <Field>
        <FieldLabel>Auto-deploy main</FieldLabel>
        <Switch v-model:checked="settings.autoDeploy"><SwitchThumb /></Switch>
      </Field>
      <Field>
        <FieldLabel>Preview deployments</FieldLabel>
        <Switch v-model:checked="settings.previews"><SwitchThumb /></Switch>
      </Field>
    </section>
    <section>
      <h2>Notifications</h2>
      <Field>
        <FieldLabel>Email me when a deploy fails</FieldLabel>
        <Switch v-model:checked="settings.emailOnFailure"><SwitchThumb /></Switch>
      </Field>
      <Field>
        <FieldLabel>Weekly digest</FieldLabel>
        <Switch v-model:checked="settings.weeklyDigest"><SwitchThumb /></Switch>
      </Field>
      <Field>
        <FieldLabel>Slack alerts</FieldLabel>
        <Switch v-model:checked="settings.slackAlerts"><SwitchThumb /></Switch>
      </Field>
    </section>
    <section>
      <h2>Members</h2>
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead>
        <tbody>
          <tr v-for="member in members" :key="member.email"><td>{{ member.name }}</td><td>{{ member.email }}</td><td>{{ member.role }}</td></tr>
        </tbody>
      </table>
    </section>
    <Button type="submit">Save changes</Button>
    <span role="status">{{ status }}</span>
  </form>
</template>
`

// What an app author writes: `connectPage` makes the ui-sdk bridge, and its `allow` is ui-sdk's own confirm path, which
// the server's `requireApproval` rules reach too. The test plays the person through `window.pageTest`: it reads the
// approvals the page asks for and answers them.
const appComponent = `<script setup lang="ts">
import { createAgent } from "@ui-sdk/vue/agent"
import { connectPage } from "vite-hub/agent/page"
import { useAgent, useChat } from "vite-hub/agent/vue"
import { connectRealtimeRoom } from "vite-hub/realtime/client"
import { onMounted } from "vue"
import ProjectSettings from "./ProjectSettings.vue"

const asks = []
const page = connectPage(createAgent, {
  join: connectRealtimeRoom,
  allow: step => step.confirm ? new Promise(resolve => asks.push({ step: { ...step }, answer: resolve })) : true,
})
const chat = useChat(useAgent("settings"), { page })

onMounted(() => {
  const changes = []
  page.agent.subscribe(change => changes.push({ label: change.label, source: change.source, value: change.value }))
  const heard = []
  Object.assign(window, {
    pageTest: {
      id: page.id,
      changes,
      asks: () => asks.map(ask => ask.step),
      answer: (index, approved) => asks[index].answer(approved),
      messages: () => JSON.parse(JSON.stringify(chat.messages.value)),
      send: text => chat.sendMessage({ text }),
      snapshot: () => page.agent.snapshot(),
      pageChanges: () => JSON.parse(JSON.stringify(page.changes())),
      undo: id => page.undo(id),
      status: () => chat.status.value,
      invocationId: () => chat.invocationId.value,
      error: () => chat.error.value?.message,
      // A second person joins someone else's page id, and counts the calls that reach them.
      intrude: id => {
        const room = connectRealtimeRoom("agent-pages", id)
        room.onRequest(body => {
          heard.push(body)
          return []
        })
        return new Promise(resolve => {
          const stop = room.onUpdate(() => {
            if (room.status() === "connected") {
              stop()
              resolve(true)
            }
          })
        })
      },
      heard: () => heard.length,
    },
  })
})
</script>

<template>
  <main>
    <ProjectSettings />
  </main>
</template>
`

const cases = [
  { name: "vite-node", framework: "vite", host: "node", port: 4831 },
  { name: "vite-cloudflare", framework: "vite", host: "cloudflare", port: 4832 },
  { name: "nuxt-node", framework: "nuxt", host: "node", port: 4833 },
  { name: "nuxt-cloudflare", framework: "nuxt", host: "cloudflare", port: 4834 },
].filter(item => !process.env.AGENT_PAGE_CASES || process.env.AGENT_PAGE_CASES.split(",").includes(item.name))

/** The vite-hub options of every case. A Node build keeps its rooms in memory, in one process. */
function hubOptions(host) {
  return { host, agent: true, auth: true, console: true, realtime: host === "node" ? { authority: "memory" } : true }
}

async function writeFixture(item) {
  const root = join(fixtures, item.name)
  await rm(root, { force: true, recursive: true })
  const files = {
    "package.json": JSON.stringify({ name: `agent-page-${item.name}`, private: true, type: "module" }),
    "server/agents/settings.ts": agentFile,
    "server/auth.ts": authFile,
    "server/state.ts": stateFile,
    "server/api/settings.get.ts": settingsGet,
    "server/api/settings.put.ts": settingsPut,
    "server/api/saves.get.ts": savesGet,
  }
  if (item.framework === "vite") {
    Object.assign(files, {
      "index.html": "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Acme Console</title></head><body><div id=\"app\"></div><script type=\"module\" src=\"/src/main.ts\"></script></body></html>\n",
      "src/main.ts": "import \"@ui-sdk/core/web.css\"\nimport { createApp } from \"vue\"\nimport App from \"./App.vue\"\n\ncreateApp(App).mount(\"#app\")\n",
      "src/App.vue": appComponent,
      "src/ProjectSettings.vue": settingsPage,
    })
  }
  else {
    Object.assign(files, {
      "nuxt.config.ts": `export default defineNuxtConfig({\n  css: ["@ui-sdk/core/web.css"],\n  modules: ["vite-hub/nuxt"],\n  vitehub: ${JSON.stringify(hubOptions(item.host))},\n})\n`,
      "app/app.vue": appComponent,
      "app/ProjectSettings.vue": settingsPage,
    })
  }
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true })
    await writeFile(join(root, file), contents)
  }
  return root
}

async function build(item, root) {
  if (item.framework === "vite") {
    const { createBuilder } = await import("vite")
    const { default: vue } = await import("@vitejs/plugin-vue")
    const { vitehub } = await import("vite-hub")
    const builder = await createBuilder({ configFile: false, logLevel: "warn", plugins: [vue(), vitehub(hubOptions(item.host))], root })
    await builder.buildApp()
    return
  }
  const { build: buildNuxt, loadNuxt } = await import("nuxt")
  const nuxt = await loadNuxt({ cwd: root, overrides: { dev: false, logLevel: "warn" } })
  try {
    await buildNuxt(nuxt)
  }
  finally {
    await nuxt.close()
  }
}

/** Starts the built app on its port. Resolves a function that stops it. */
async function start(item, root, vars) {
  const origin = `http://127.0.0.1:${item.port}`
  if (item.host === "node") {
    const server = spawn(process.execPath, [join(root, ".output/server/index.mjs")], {
      // The Agent journal goes to `.vitehub/data` under the working directory.
      cwd: root,
      env: { ...process.env, ...vars, HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1", NITRO_PORT: String(item.port), PORT: String(item.port) },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const output = []
    server.stdout.on("data", chunk => output.push(String(chunk)))
    server.stderr.on("data", chunk => output.push(String(chunk)))
    await waitForServer(origin, () => output.join(""))
    return { origin, logs: () => output.join(""), stop: () => new Promise(resolve => server.once("exit", resolve).kill()) }
  }
  const { Miniflare } = await import("miniflare")
  const server = join(root, ".output/server")
  const wrangler = JSON.parse(await readFile(join(server, "wrangler.json"), "utf8"))
  const files = (await readdir(server, { recursive: true })).filter(file => file.endsWith(".mjs"))
  const worker = new Miniflare({
    // The build writes today's date. The pinned workerd binary can be older.
    compatibilityDate: "2026-04-20",
    compatibilityFlags: [...new Set([...wrangler.compatibility_flags ?? [], "nodejs_compat"])],
    durableObjects: Object.fromEntries((wrangler.durable_objects?.bindings ?? []).map(binding => [binding.name, { className: binding.class_name, useSQLite: true }])),
    ...wrangler.assets ? { assets: { directory: join(server, wrangler.assets.directory ?? "../public"), binding: wrangler.assets.binding, routerConfig: { has_user_worker: true } } } : {},
    host: "127.0.0.1",
    // Wrangler uploads every chunk, so the Worker can import the lazy ones.
    modules: ["index.mjs", ...files.filter(file => file !== "index.mjs")].map(file => ({ path: join(server, file), type: "ESModule" })),
    modulesRoot: server,
    port: item.port,
    bindings: vars,
  })
  await worker.ready
  await waitForServer(origin, () => "")
  return { origin, logs: () => "", stop: () => worker.dispose() }
}

async function waitForServer(origin, logs) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/settings`)
      if (response.ok) return
    }
    catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`The app did not start at ${origin}.\n${logs()}`)
}

const browser = cases.length ? await chromium.launch() : undefined
const consoleKey = await createConsoleKeyPair()

/** A signed-in person: a browser context with a session cookie, and the app open in it. */
async function signIn(app, name, email) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const response = await context.request.post(`${app.origin}/api/auth/sign-up/email`, {
    data: { name, email, password: "correct-horse-battery-staple" },
    headers: { origin: app.origin },
  })
  assert.equal(response.status(), 200, await response.text())
  const user = (await response.json()).user
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(app.origin, { waitUntil: "load" })
  await page.waitForFunction(() => Boolean(window.pageTest && document.querySelector("form button")), undefined, { timeout: 30_000 })
  return { context, errors, page, user }
}

/** Sends a prompt, answers the approvals the page asks for in order, and waits for the reply. */
async function ask(person, prompt, answers = []) {
  const before = await person.page.evaluate(() => ({ asks: window.pageTest.asks().length, replies: window.pageTest.messages().filter(message => message.role === "assistant").length }))
  await person.page.evaluate(text => void window.pageTest.send(text), prompt)
  const asked = []
  for (const approved of answers) {
    const index = before.asks + asked.length
    await person.page.waitForFunction(at => window.pageTest.asks().length > at || window.pageTest.status() === "error", index, { timeout: 120_000 })
    const step = await person.page.evaluate(at => window.pageTest.asks()[at], index)
    assert.ok(step, `no approval asked: ${await person.page.evaluate(() => window.pageTest.error())}`)
    asked.push({ step, server: await serverState(person.app) })
    await person.page.evaluate(([at, value]) => window.pageTest.answer(at, value), [index, approved])
  }
  await person.page.waitForFunction((count) => {
    const status = window.pageTest.status()
    return (status === "ready" || status === "error") && window.pageTest.messages().filter(message => message.role === "assistant").length > count
  }, before.replies, { timeout: 120_000 })
  const result = await person.page.evaluate(() => ({
    error: window.pageTest.error(),
    invocationId: window.pageTest.invocationId(),
    messages: window.pageTest.messages(),
    snapshot: window.pageTest.snapshot(),
    status: window.pageTest.status(),
  }))
  const last = result.messages.filter(message => message.role === "assistant").at(-1)
  const toolParts = (last?.parts ?? []).filter(part => part.type.startsWith("tool-"))
  const byLabel = Object.fromEntries(result.snapshot.filter(component => component.label).map(component => [component.label, component]))
  return { ...result, asked, byLabel, toolParts, context: JSON.stringify({ error: result.error, logs: person.app.logs().slice(-4000), parts: toolParts }, null, 2) }
}

async function serverState(app) {
  return {
    settings: await (await fetch(`${app.origin}/api/settings`)).json(),
    saves: await (await fetch(`${app.origin}/api/saves`)).json(),
  }
}

/** Runs the vitehub CLI against the app's Console, signed with the test key, and parses its JSON. */
async function vitehub(app, args) {
  const { stdout } = await run(process.execPath, [cli, ...args, "--url", `${app.origin}/_vitehub`, "--json"], {
    cwd: app.root,
    env: { ...process.env, VITEHUB_CONSOLE_PRIVATE_KEY_CI: consoleKey.privateKey },
    timeout: 60_000,
  })
  return JSON.parse(stdout)
}

for (const item of cases) {
  test(`${item.name}: an Agent works the page under the server's rules, and every change is listed and undone`, { timeout: 900_000 }, async (t) => {
    const root = await writeFixture(item)
    await build(item, root)
    const app = { root, ...await start(item, root, { BETTER_AUTH_SECRET: secret, BETTER_AUTH_URL: `http://127.0.0.1:${item.port}`, VITEHUB_SECRET: secret, VITEHUB_CONSOLE_KEY_CI: consoleKey.publicKey }) }
    t.after(() => app.stop())
    const ada = { app, ...await signIn(app, "Ada Lovelace", "ada@acme.dev") }
    const grace = { app, ...await signIn(app, "Grace Hopper", "grace@acme.dev") }
    t.after(() => Promise.all([ada.context.close(), grace.context.close()]))
    const pageId = await ada.page.evaluate(() => window.pageTest.id)

    // Grace joins Ada's page id. Every call below must still reach only Ada's tab.
    await grace.page.evaluate(id => window.pageTest.intrude(id), pageId)

    // 1. The settings task. The save needs Ada's approval: nothing is saved while she decides.
    const settings = await ask(ada, prompts.settings, [true])
    assert.equal(settings.status, "ready", settings.context)
    assert.deepEqual(settings.toolParts.map(part => part.type), ["tool-page_snapshot", "tool-page_act", "tool-page_act"], settings.context)
    for (const part of settings.toolParts) {
      assert.equal(part.state, "output-available", JSON.stringify(part, null, 2))
      assert.notEqual(part.output?.ok, false, JSON.stringify(part.output, null, 2))
    }
    assert.equal(settings.asked.length, 1, settings.context)
    assert.equal(settings.asked[0].step.label, "Save changes", JSON.stringify(settings.asked[0].step))
    assert.deepEqual(settings.asked[0].server.saves, [], "the save waited for the approval")
    assert.equal(settings.byLabel["Default region"]?.value, "fra")
    assert.equal(settings.byLabel.Visibility?.value, "team")
    assert.equal(settings.byLabel["Email me when a deploy fails"]?.checked, false)
    const changes = await ada.page.evaluate(() => window.pageTest.changes)
    assert.deepEqual([...new Set(changes.map(change => change.source))], ["agent"], JSON.stringify(changes))
    let server = await serverState(app)
    assert.deepEqual(server.settings, expectedSettings)
    assert.equal(server.saves.length, 1)

    // 2. A denied step, named by the field's ref id: a named diagnostic, and the page and the server keep "Atlas".
    const rename = await ask(ada, prompts.rename)
    assert.equal(rename.status, "ready", rename.context)
    const renamed = rename.toolParts.find(part => part.type === "tool-page_act")
    assert.equal(renamed?.output?.ok, false, rename.context)
    assert.equal(renamed?.output?.code, "AGENT_R1047", rename.context)
    assert.equal(rename.byLabel["Project name"]?.value, "Atlas")
    assert.equal((await serverState(app)).settings.name, "Atlas")

    // 3. Two steps that need approval in one call: Ada approves the digest and refuses the save.
    const digest = await ask(ada, prompts.digest, [true, false])
    assert.equal(digest.status, "ready", digest.context)
    assert.deepEqual(digest.asked.map(entry => entry.step.label), ["Weekly digest", "Save changes"])
    const digestAct = digest.toolParts.find(part => part.type === "tool-page_act")
    assert.equal(digestAct?.output?.code, "AGENT_R1049", digest.context)
    assert.equal(digest.byLabel["Weekly digest"]?.checked, true)
    assert.equal((await serverState(app)).saves.length, 1)

    // 4. The CLI lists every change of the settings run: Agent, page, person, step, before, after and time.
    const shown = await vitehub(app, ["agent", "invocations", "show", settings.invocationId])
    assert.equal(shown.agentName ?? shown.record?.agentName, "settings", JSON.stringify(shown).slice(0, 2000))
    const listed = shown.pageChanges
    assert.ok(Array.isArray(listed), JSON.stringify(shown).slice(0, 2000))
    const listedValues = listed.map(change => [change.label, change.key, change.before, change.after])
    assert.deepEqual(listedValues, [
      ["Default region", "value", "iad", "fra"],
      ["Visibility", "value", "private", "team"],
      ["Email me when a deploy fails", "checked", true, false],
    ], JSON.stringify(listed, null, 2))
    for (const change of listed) {
      assert.equal(change.page, pageId)
      assert.equal(change.user, ada.user.id)
      assert.equal(typeof change.step, "number")
      assert.ok(!Number.isNaN(Date.parse(change.at)), change.at)
      assert.equal(typeof change.id, "string")
    }
    const approvals = shown.approvals ?? []
    assert.ok(approvals.some(approval => approval.approved === true), JSON.stringify(approvals))

    // 5. Undo from the page puts the region back, and an operator's undo puts the visibility back.
    const region = listed.find(change => change.label === "Default region")
    const visibility = listed.find(change => change.label === "Visibility")
    const pageChanges = await ada.page.evaluate(() => window.pageTest.pageChanges())
    assert.ok(pageChanges.some(change => change.id === region.id), JSON.stringify(pageChanges))
    const notRestored = await ada.page.evaluate(id => window.pageTest.undo(id), region.id)
    assert.deepEqual(notRestored, [])
    const undone = await vitehub(app, ["invocations", "undo", settings.invocationId, "--change", visibility.id])
    assert.deepEqual(undone.notRestored ?? [], [], JSON.stringify(undone))
    const afterUndo = Object.fromEntries((await ada.page.evaluate(() => window.pageTest.snapshot())).filter(component => component.label).map(component => [component.label, component]))
    assert.equal(afterUndo["Default region"]?.value, "iad")
    assert.equal(afterUndo.Visibility?.value, "private")
    assert.equal(afterUndo["Email me when a deploy fails"]?.checked, false)

    // 6. Grace heard none of Ada's calls, and her own run cannot reach Ada's page by its id.
    assert.equal(await grace.page.evaluate(() => window.pageTest.heard()), 0)
    const intruded = await grace.page.evaluate(async ({ id, text }) => {
      const response = await fetch("/api/_vitehub/agents/settings/chat", {
        method: "POST",
        headers: { "content-type": "application/json", "x-vitehub-page": id },
        body: JSON.stringify({ messages: [{ id: "grace-1", role: "user", parts: [{ type: "text", text }] }] }),
      })
      return { status: response.status, body: await response.text() }
    }, { id: pageId, text: prompts.read })
    assert.equal(intruded.status, 200, intruded.body.slice(0, 2000))
    const snapshotOutput = intruded.body.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(event => event.type === "tool-output-available")
    assert.equal(snapshotOutput?.output?.code, "REALTIME_ROOM_EMPTY", intruded.body.slice(0, 2000))
    assert.equal(await grace.page.evaluate(() => window.pageTest.heard()), 0)

    assert.deepEqual([...ada.errors, ...grace.errors], [])
  })
}

test.after(async () => {
  await browser?.close()
})
