#!/usr/bin/env node
import { realpathSync } from "node:fs"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { runViteHubCli } from "@vite-hub/cli"

function isCliEntrypoint() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  }
  catch {
    return false
  }
}

if (isCliEntrypoint()) {
  runViteHubCli().then((exitCode) => {
    process.exit(exitCode)
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
