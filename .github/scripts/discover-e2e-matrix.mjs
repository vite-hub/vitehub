import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"

const defaultProviders = ["cloudflare", "vercel"]
const selectedFramework = process.env.VITEHUB_CI_FRAMEWORK || ""
const selectedPackage = process.env.VITEHUB_CI_PACKAGE || ""
const selectedProvider = process.env.VITEHUB_CI_PROVIDER || ""

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

function matchesSelection(value, selection) {
  return !selection || selection === "all" || selection === value
}

function discoverFrameworks(packageDir) {
  const playgroundDir = join(packageDir, "playground")
  if (!existsSync(playgroundDir)) return []
  return readdirSync(playgroundDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith("."))
    .map(entry => entry.name)
    .sort()
}

function packageLabel(manifest, packageDir) {
  return manifest.name?.replace(/^@vitehub\//, "") ?? basename(packageDir)
}

function discoverPackages() {
  return readdirSync("packages", { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join("packages", entry.name))
    .filter(packageDir => existsSync(join(packageDir, "package.json")))
    .sort()
}

const local = []
const live = []

for (const packageDir of discoverPackages()) {
  const manifest = readJson(join(packageDir, "package.json"))
  if (!manifest.scripts?.["test:e2e"]) continue

  const e2e = manifest.vitehub?.ci?.e2e ?? {}
  const packageName = packageLabel(manifest, packageDir)
  if (!matchesSelection(packageName, selectedPackage)) continue

  const providers = e2e.providers ?? defaultProviders
  const frameworks = e2e.frameworks ?? discoverFrameworks(packageDir)

  for (const framework of frameworks) {
    if (!matchesSelection(framework, selectedFramework)) continue
    for (const provider of providers) {
      if (!matchesSelection(provider, selectedProvider)) continue
      local.push({ framework, packageDir, packageName, provider })
    }
  }

  const liveConfig = e2e.live ?? {}
  if (!liveConfig.enabled) continue

  const liveProviders = liveConfig.providers ?? providers
  const liveFrameworks = liveConfig.frameworks ?? frameworks
  const appPrefix = liveConfig.appPrefix ?? `vitehub-${packageName}-playground`
  const cloudflare = liveConfig.cloudflare ?? {}
  const vercel = liveConfig.vercel ?? {}
  const cloudflareDeployStrategy = cloudflare.strategy ?? "template"
  const cloudflareWranglerTemplate = cloudflare.wranglerTemplate ?? "playground/_shared/wrangler.template.jsonc"

  for (const framework of liveFrameworks) {
    if (!matchesSelection(framework, selectedFramework)) continue
    for (const provider of liveProviders) {
      if (!matchesSelection(provider, selectedProvider)) continue
      if (provider === "cloudflare" && cloudflareDeployStrategy === "template" && !existsSync(join(packageDir, cloudflareWranglerTemplate))) continue
      live.push({
        appName: `${appPrefix}-${framework}`,
        cloudflareCreateQueues: Boolean(cloudflare.createQueues),
        cloudflareCreateR2Bucket: Boolean(cloudflare.createR2Bucket),
        cloudflareDeployStrategy,
        cloudflareWranglerTemplate,
        framework,
        packageDir,
        packageName,
        provider,
        requiresVercelBlobDeployEnv: Boolean(vercel.deployEnv?.blobReadWriteToken),
        requiresVercelKvBuildEnv: Boolean(vercel.buildEnv?.kv),
        requiresVercelSandboxBuildEnv: Boolean(vercel.buildEnv?.sandbox),
      })
    }
  }
}

const output = [
  `local=${JSON.stringify({ include: local })}`,
  `live=${JSON.stringify({ include: live })}`,
  `hasLocal=${local.length > 0}`,
  `hasLive=${live.length > 0}`,
].join("\n")

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`)
}
else {
  console.log(output)
}
