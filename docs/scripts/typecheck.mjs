import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { delimiter, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const knownDocusDiagnostics = new Set([
  "app/app.vue:43:25:TS2571",
  "app/components/OgImage/Docs.takumi.vue:19:84:TS2731",
  "app/components/OgImage/Landing.takumi.vue:62:73:TS2731",
  "app/error.vue:39:25:TS2571",
  "app/plugins/i18n.ts:52:77:TS2339",
  "modules/assistant/runtime/components/AssistantPanel.vue:162:12:TS2322",
  "modules/assistant/runtime/components/AssistantPanel.vue:204:39:TS2345",
  "modules/assistant/runtime/components/AssistantPanel.vue:216:47:TS2345",
  "modules/assistant/runtime/components/AssistantPanel.vue:231:39:TS2345",
  "modules/assistant/runtime/composables/useAssistant.ts:59:49:TS2339",
])

const vueTsc = fileURLToPath(import.meta.resolve("vue-tsc/bin/vue-tsc.js"))
const require = createRequire(import.meta.url)
const nuxtRequire = createRequire(require.resolve("nuxt/package.json"))
const vueRouterNodeModules = dirname(dirname(nuxtRequire.resolve("vue-router/package.json")))
const result = spawnSync(process.execPath, [vueTsc, "--noEmit", "--pretty", "false"], {
  encoding: "utf8",
  env: {
    ...process.env,
    NODE_PATH: [vueRouterNodeModules, process.env.NODE_PATH].filter(Boolean).join(delimiter),
  },
  maxBuffer: 10 * 1024 * 1024,
})
const stdout = result.stdout || ""
const stderr = result.stderr || ""

if (result.status === 0) {
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  process.exit(0)
}

const lines = `${stdout}${stderr}`.split(/\r?\n/)
const diagnosticKeys = []
let hasUnexpectedOutput = false
for (const line of lines) {
  if (!line) continue
  const match = /^(.*)\((\d+),(\d+)\): error (TS\d+):/.exec(line)
  if (match) {
    const path = match[1].replaceAll("\\", "/")
    const docusPath = path.split("/node_modules/docus/")[1]
    diagnosticKeys.push(docusPath ? `${docusPath}:${match[2]}:${match[3]}:${match[4]}` : "")
  }
  else if (diagnosticKeys.length === 0 || !/^\s/.test(line)) {
    hasUnexpectedOutput = true
  }
}

if (
  result.error
  || result.signal
  || diagnosticKeys.length === 0
  || hasUnexpectedOutput
  || diagnosticKeys.some(diagnostic => !knownDocusDiagnostics.has(diagnostic))
) {
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  process.exit(result.status || 1)
}
