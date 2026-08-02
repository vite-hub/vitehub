#!/usr/bin/env node
import process from "node:process"

import { runViteHubCli } from "@vite-hub/cli"
import { loadViteHubCliConfig } from "./internal/cli-config.ts"

runViteHubCli({ loadConfig: loadViteHubCliConfig }).then((exitCode) => {
  process.exit(exitCode)
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
