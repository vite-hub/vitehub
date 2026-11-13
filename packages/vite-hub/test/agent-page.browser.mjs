// The page bridge from end to end: a Vue page runs ui-sdk's `createAgent()`, `useChat(agent, { page })` connects it,
// and a ViteHub Agent with a scripted model changes three settings and saves them through `page_snapshot` and
// `page_act`, over Realtime. It builds the same app with Vite and with Nuxt 5, for Node and for Cloudflare (workerd
// through Miniflare), opens it in headless Chromium, and checks the page, the server, the tool calls and the change
// sources. The settings page is the N1 "change a setting" task (vite-hub/nuxt-evals tasks/vitehub-ui/operate).
// Run: pnpm --filter vite-hub test:browser   (AGENT_PAGE_CASES=vite-node,nuxt-cloudflare picks cases)
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { chromium } from "playwright-core"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const fixtures = join(packageRoot, ".cache/agent-page")
const prompt = "Set the default region to Frankfurt, make the project visible to the whole team, and turn off the email I get when a deploy fails. Leave everything else as it is, and save."
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

// The scripted model: the calls a model makes for the N1 task. It reads the page once, makes the three changes in one
// step list, and saves in a separate call, as `act`'s description asks.
const agentFile = `import { simulateReadableStream } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { defineAgent } from "vite-hub/agent"
import { page } from "vite-hub/agent/capabilities"

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
const model = new MockLanguageModelV3({
  doStream: [
    toolCall("call-1", "page_snapshot", {}),
    toolCall("call-2", "page_act", { steps: [
      { ref: "Default region", action: "setValue", args: ["Frankfurt (eu-central-1)"] },
      { ref: "Visibility", action: "setValue", args: ["Team"] },
      { ref: "Email me when a deploy fails", action: "setChecked", args: [false] },
    ] }),
    toolCall("call-3", "page_act", { steps: [{ ref: "Save changes", action: "press" }] }),
    reply([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Saved: Frankfurt, Team, and no email on failed deploys." },
      { type: "text-end", id: "text-1" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ]),
  ],
})

export default defineAgent({
  capabilities: [page()],
  driver: { model },
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

// What an app author writes: one ui-sdk bridge, handed to the chat. The test reads the bridge's changes and the chat
// through `window.pageTest`.
const appComponent = `<script setup lang="ts">
import { createAgent } from "@ui-sdk/vue/agent"
import { useAgent, useChat } from "vite-hub/agent/vue"
import { onMounted } from "vue"
import ProjectSettings from "./ProjectSettings.vue"

const bridge = createAgent()
const chat = useChat(useAgent("settings"), { page: bridge })

onMounted(() => {
  const changes = []
  bridge.subscribe(change => changes.push({ label: change.label, source: change.source, value: change.value }))
  Object.assign(window, {
    pageTest: {
      changes,
      messages: () => JSON.parse(JSON.stringify(chat.messages.value)),
      send: text => chat.sendMessage({ text }),
      snapshot: () => bridge.snapshot(),
      status: () => chat.status.value,
      error: () => chat.error.value?.message,
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
  return { host, agent: true, realtime: host === "node" ? { authority: "memory" } : true }
}

async function writeFixture(item) {
  const root = join(fixtures, item.name)
  await rm(root, { force: true, recursive: true })
  const files = {
    "package.json": JSON.stringify({ name: `agent-page-${item.name}`, private: true, type: "module" }),
    "server/agents/settings.ts": agentFile,
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
async function start(item, root) {
  const origin = `http://127.0.0.1:${item.port}`
  if (item.host === "node") {
    const server = spawn(process.execPath, [join(root, ".output/server/index.mjs")], {
      env: { ...process.env, HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1", NITRO_PORT: String(item.port), PORT: String(item.port) },
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

for (const item of cases) {
  test(`${item.name}: an Agent changes three settings and saves through the page bridge`, { timeout: 600_000 }, async (t) => {
    const root = await writeFixture(item)
    await build(item, root)
    const app = await start(item, root)
    t.after(() => app.stop())
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    t.after(() => page.close())
    const pageErrors = []
    page.on("pageerror", error => pageErrors.push(error.message))

    await page.goto(app.origin, { waitUntil: "load" })
    await page.waitForFunction(() => Boolean(window.pageTest && document.querySelector("form button")), undefined, { timeout: 30_000 })
    await page.evaluate(text => window.pageTest.send(text), prompt)
    await page.waitForFunction(() => {
      const status = window.pageTest.status()
      return (status === "ready" || status === "error") && window.pageTest.messages().some(message => message.role === "assistant")
    }, undefined, { timeout: 120_000 })

    const result = await page.evaluate(() => ({
      changes: window.pageTest.changes,
      error: window.pageTest.error(),
      messages: window.pageTest.messages(),
      snapshot: window.pageTest.snapshot(),
      status: window.pageTest.status(),
    }))
    const context = JSON.stringify({ error: result.error, pageErrors, logs: app.logs().slice(-4000), messages: result.messages }, null, 2)
    assert.equal(result.status, "ready", context)

    // The model's tool calls, as the chat received them: three, every one answered by the page.
    const toolParts = result.messages.filter(message => message.role === "assistant").flatMap(message => message.parts).filter(part => part.type.startsWith("tool-"))
    assert.deepEqual(toolParts.map(part => part.type), ["tool-page_snapshot", "tool-page_act", "tool-page_act"], context)
    assert.ok(toolParts.length <= 5, context)
    for (const part of toolParts) {
      assert.equal(part.state, "output-available", JSON.stringify(part, null, 2))
      assert.notEqual(part.output?.ok, false, JSON.stringify(part.output, null, 2))
    }

    // The page shows the new values.
    const byLabel = Object.fromEntries(result.snapshot.filter(component => component.label).map(component => [component.label, component]))
    assert.equal(byLabel["Default region"]?.value, "fra", JSON.stringify(result.snapshot, null, 2))
    assert.equal(byLabel.Visibility?.value, "team", JSON.stringify(result.snapshot, null, 2))
    assert.equal(byLabel["Email me when a deploy fails"]?.checked, false, JSON.stringify(result.snapshot, null, 2))

    // Every change the bridge made reached the page as the agent's.
    assert.ok(result.changes.length >= 3, JSON.stringify(result.changes))
    assert.deepEqual([...new Set(result.changes.map(change => change.source))], ["agent"], JSON.stringify(result.changes))

    // The server saved once, with the right values.
    const settings = await (await fetch(`${app.origin}/api/settings`)).json()
    const saves = await (await fetch(`${app.origin}/api/saves`)).json()
    assert.deepEqual(settings, expectedSettings)
    assert.equal(saves.length, 1)
    assert.deepEqual(pageErrors, [])
  })
}

test.after(async () => {
  await browser?.close()
})
