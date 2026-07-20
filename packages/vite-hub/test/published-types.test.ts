import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { it } from "vitest"

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const tsc = resolve(packageRoot, "../../node_modules/typescript/bin/tsc")

it("publishes Env's Vite config augmentation from the framework root", async () => {
  await execFileAsync(process.execPath, [tsc, "--noEmit", "-p", resolve(packageRoot, "fixtures/published-types")])
}, 10_000)
