import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const tsrsManifest = new URL(import.meta.resolve("tsrs/package.json"))
const tsrsPlatforms = Object.keys(JSON.parse(readFileSync(tsrsManifest, "utf8")).optionalDependencies)

export function packageTypecheckCompiler(platform = process.platform, arch = process.arch) {
  const prefix = `@tsrs/${platform}-${arch}`
  const supported = tsrsPlatforms.some(name => name === prefix || name.startsWith(`${prefix}-`))
  // Keep the previous compiler on hosts for which tsrs ships no native payload.
  // Let supported hosts report installation or compiler errors without a fallback.
  return supported
    ? new URL("./bin/tsrs", tsrsManifest)
    : new URL("./bin/tsc", import.meta.resolve("typescript-native/package.json"))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const projects = args.flatMap((arg, index) => arg === "-p" || arg === "--project" ? [args[index + 1]] : [])
  if (projects.length < 2) await import(packageTypecheckCompiler().href)
  else {
    // Check each `-p` project in turn, so errors in one project do not hide the errors of the next.
    const options = args.filter((arg, index) => arg !== "-p" && arg !== "--project" && args[index - 1] !== "-p" && args[index - 1] !== "--project")
    const compiler = fileURLToPath(packageTypecheckCompiler())
    const failed = projects.filter(project => spawnSync(process.execPath, [compiler, ...options, "-p", project], { stdio: "inherit" }).status !== 0)
    process.exitCode = failed.length ? 1 : 0
  }
}
