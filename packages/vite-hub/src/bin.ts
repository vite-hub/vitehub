#!/usr/bin/env node
import { runViteHubCliEntrypoint } from "@vite-hub/cli"
import { loadViteHubCliConfig } from "./internal/cli-config.ts"

runViteHubCliEntrypoint({ loadConfig: loadViteHubCliConfig })
