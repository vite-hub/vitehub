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
  await import(packageTypecheckCompiler().href)
}
