import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { consoleRuntimeDigestFile, digestConsoleRuntime } from "../src/console/runtime-digest.ts"

// A cold start would otherwise read the 2 MB of Console runtime files to compute this digest.
const root = join(import.meta.dirname, "../dist/console/runtime")
writeFileSync(join(root, consoleRuntimeDigestFile), `${digestConsoleRuntime(root)}\n`)
