import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"

const defaultProviders = ["cloudflare", "vercel"]

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
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
  const providers = e2e.providers ?? defaultProviders
  const frameworks = e2e.frameworks ?? discoverFrameworks(packageDir)
  const packageName = packageLabel(manifest, packageDir)

  for (const framework of frameworks) {
    for (const provider of providers) {
      local.push({ framework, packageDir, packageName, provider })
    }
  }

  if (!e2e.live?.enabled) continue

  const liveProviders = e2e.live.providers ?? providers
  const liveFrameworks = e2e.live.frameworks ?? frameworks
  const appPrefix = e2e.live.appPrefix ?? `vitehub-${packageName}-playground`
  const cloudflareWranglerTemplate = e2e.live.cloudflare?.wranglerTemplate

  for (const framework of liveFrameworks) {
    for (const provider of liveProviders) {
      if (provider === "cloudflare" && cloudflareWranglerTemplate && !existsSync(join(packageDir, cloudflareWranglerTemplate))) continue
      live.push({
        appName: `${appPrefix}-${framework}`,
        cloudflareWranglerTemplate,
        framework,
        packageDir,
        packageName,
        provider,
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
