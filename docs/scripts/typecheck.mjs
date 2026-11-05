import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { delimiter, dirname } from "node:path"
import { fileURLToPath } from "node:url"

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
process.stdout.write(result.stdout || "")
process.stderr.write(result.stderr || "")
process.exit(result.error || result.signal ? 1 : result.status ?? 1)
