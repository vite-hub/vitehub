import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

function pushUnique(array, item, getKey) {
  const key = getKey(item)
  if (!array.some(entry => getKey(entry) === key)) array.push(item)
}

function queueBindingName(queue) {
  const encoded = Buffer.from(queue).toString("hex").toUpperCase()
  return encoded ? `QUEUE_${encoded}` : "QUEUE"
}

function normalizeWranglerConfig(config) {
  config.compatibility_flags = [...new Set([...(config.compatibility_flags || []), "nodejs_compat"])]
  config.no_bundle = true
  config.rules ||= []
  if (!config.rules.some(rule => rule?.type === "ESModule")) {
    config.rules.push({ type: "ESModule", globs: ["**/*.mjs", "**/*.js"] })
  }
  return config
}

function ensureConfigFromNitro() {
  const nitroConfig = ".output/nitro.json"
  if (!existsSync(nitroConfig)) return null

  const nitro = JSON.parse(readFileSync(nitroConfig, "utf8"))
  const serverDir = resolve(".output/server")
  const configPath = join(serverDir, "wrangler.deploy.json")
  const cloudflare = nitro.config?.cloudflare || {}
  const wrangler = cloudflare.wrangler || {}

  mkdirSync(serverDir, { recursive: true })
  writeFileSync(configPath, `${JSON.stringify({
    assets: { binding: "ASSETS", directory: "../public" },
    compatibility_date: "2025-07-15",
    compatibility_flags: cloudflare.nodeCompat ? ["nodejs_compat"] : [],
    main: "index.mjs",
    no_bundle: true,
    rules: [{ type: "ESModule", globs: ["**/*.mjs", "**/*.js"] }],
    ...wrangler,
  }, null, 2)}\n`)

  return configPath
}

function substituteEnv(template) {
  return template.replaceAll(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/g, (_, bracketed, bare) => process.env[bracketed || bare] || "")
}

const deployStrategy = process.env.CLOUDFLARE_DEPLOY_STRATEGY || "template"
const outputDir = resolve(".output")
const serverDir = resolve(".output/server")

mkdirSync(outputDir, { recursive: true })
mkdirSync(serverDir, { recursive: true })

if (deployStrategy === "template") {
  const templatePath = join(process.env.GITHUB_WORKSPACE, process.env.PACKAGE_DIR, process.env.WRANGLER_TEMPLATE)
  const template = substituteEnv(readFileSync(templatePath, "utf8"))
  const config = normalizeWranglerConfig(JSON.parse(template))
  writeFileSync(join(outputDir, "wrangler.deploy.json"), `${JSON.stringify(config, null, 2)}\n`)
  writeFileSync(join(outputDir, "cloudflare-deploy-dir.txt"), ".output\n")
  writeFileSync(join(outputDir, "cloudflare-deploy-config.txt"), "wrangler.deploy.json\n")
  writeFileSync(join(outputDir, "cloudflare-queues.txt"), "\n")
  process.exit(0)
}

const candidates = [
  ".output/server/wrangler.deploy.json",
  ".output/server/wrangler.json",
  ".output/wrangler.deploy.json",
  ".output/wrangler.json",
]

const configPath = candidates.find(candidate => existsSync(candidate)) || ensureConfigFromNitro()
if (!configPath) {
  throw new Error(`Unable to locate generated Wrangler config for ${process.env.PACKAGE_NAME}/${process.env.FRAMEWORK}.`)
}

const config = JSON.parse(readFileSync(configPath, "utf8"))
config.name = process.env.APP_NAME
normalizeWranglerConfig(config)

const queues = new Set()
if (process.env.CLOUDFLARE_CREATE_QUEUES === "true") {
  const queue = `welcome-email-${process.env.FRAMEWORK}`
  config.queues ||= {}
  config.queues.consumers ||= []
  config.queues.producers ||= []
  pushUnique(config.queues.consumers, { queue }, entry => String(entry.queue))
  pushUnique(
    config.queues.producers,
    { binding: queueBindingName(queue), queue },
    entry => `${String(entry.binding)}:${String(entry.queue)}`,
  )
}

for (const consumer of config.queues?.consumers || []) {
  if (consumer.queue) queues.add(String(consumer.queue))
}
for (const producer of config.queues?.producers || []) {
  if (producer.queue) queues.add(String(producer.queue))
}

writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
writeFileSync(join(outputDir, "cloudflare-queues.txt"), `${[...queues].join("\n")}\n`)
writeFileSync(join(outputDir, "cloudflare-deploy-dir.txt"), `${dirname(configPath)}\n`)
writeFileSync(join(outputDir, "cloudflare-deploy-config.txt"), `${configPath.split("/").at(-1)}\n`)
