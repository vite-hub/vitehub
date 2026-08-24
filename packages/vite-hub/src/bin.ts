#!/usr/bin/env node
import process from "node:process"

import { runViteHubCli } from "@vite-hub/cli"
import { loadViteHubCliConfig } from "./internal/cli-config.ts"

runViteHubCli({ loadConfig: loadViteHubCliConfig }).then((exitCode) => {
  process.exitCode = exitCode
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
