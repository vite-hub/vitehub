import { cp, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const source = resolve(packageDir, "devtools/.output/public")
const target = resolve(packageDir, "dist/devtools-client")

await rm(target, { force: true, recursive: true })
await cp(source, target, { recursive: true })
