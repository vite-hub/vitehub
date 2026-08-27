#!/usr/bin/env node
import process from "node:process"

import { runViteHubCli } from "@vite-hub/cli"
import { loadViteHubCliConfig } from "./internal/cli-config.ts"

function exitAfterStandardStreamsFlush(exitCode: number): void {
  let pending = 2
  const flushed = () => {
    pending--
    if (pending === 0) process.exit(exitCode)
  }
  process.stdout.write("", flushed)
  process.stderr.write("", flushed)
}

runViteHubCli({ loadConfig: loadViteHubCliConfig }).then((exitCode) => {
  exitAfterStandardStreamsFlush(exitCode)
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  exitAfterStandardStreamsFlush(1)
})
