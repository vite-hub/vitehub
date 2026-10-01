#!/usr/bin/env node
import { runViteHubCliEntrypoint } from "@vite-hub/cli"
import { createBoxCliNamespace } from "./box-cli.ts"
import { loadViteHubCliConfig } from "./internal/cli-config.ts"

runViteHubCliEntrypoint({ loadConfig: loadViteHubCliConfig, runtimeNamespaces: [createBoxCliNamespace()] })
