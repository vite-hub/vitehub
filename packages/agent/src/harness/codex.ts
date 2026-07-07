import { chmodSync, existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createCodex } from "@ai-sdk/harness-codex"

import { createLocalHarnessSandbox, type LocalHarnessSandboxOptions } from "./local-sandbox.ts"

import type { CodexHarnessSettings } from "@ai-sdk/harness-codex"
import type { AgentHarnessCredentialSource, AgentHarnessDriver } from "../types.ts"

export interface CodexDriverOptions extends CodexHarnessSettings {
  authJson?: string
  authJsonPath?: string
  credentials?: AgentHarnessCredentialSource
  env?: Record<string, string | undefined>
  sandbox?: false | LocalHarnessSandboxOptions
}

export function codexDriver(options: CodexDriverOptions = {}): AgentHarnessDriver {
  const {
    authJson,
    authJsonPath,
    credentials,
    env,
    sandbox,
    ...settings
  } = options
  const defaultOpenAIAuth = settings.auth === undefined
  const auth = settings.auth ?? { openai: {} }

  return {
    credentials: credentials ?? { label: "Codex", source: "ambient" },
    harness: createCodex({ ...settings, auth }),
    ...(sandbox === false
      ? {}
      : {
          sandbox: createLocalHarnessSandbox({
            ...sandbox,
            env: codexLocalEnv({
              authJson,
              authJsonPath,
              env: {
                ...env,
                ...sandbox?.env,
              },
              preferOpenAI: defaultOpenAIAuth,
            }),
          }),
        }),
  }
}

function codexLocalEnv(options: {
  authJson?: string
  authJsonPath?: string
  env?: Record<string, string | undefined>
  preferOpenAI: boolean
}): Record<string, string | undefined> {
  const env = {
    ...process.env,
    ...options.env,
  }

  if (options.preferOpenAI) {
    delete env.AI_GATEWAY_API_KEY
    delete env.AI_GATEWAY_BASE_URL
  }

  const codexHome = codexHomeFromAuth({
    authJson: options.authJson ?? env.CODEX_AUTH_JSON,
    authJsonPath: options.authJsonPath,
  })
  if (codexHome) env.CODEX_HOME = codexHome
  env.PATH = [
    join(process.cwd(), "node_modules", ".bin"),
    env.HOME ? join(env.HOME, ".local", "bin") : undefined,
    env.PATH,
  ].filter(Boolean).join(":")
  return env
}

function codexHomeFromAuth(options: { authJson?: string, authJsonPath?: string }): string | undefined {
  const authJson = options.authJson?.trim()
  const authJsonPath = options.authJsonPath?.trim()
  if (!authJson && !authJsonPath) return

  const dir = mkdtempSync(join(tmpdir(), "vitehub-codex-home-"))
  chmodSync(dir, 0o700)
  writeFileSync(join(dir, "config.toml"), "")
  if (authJson) {
    writeFileSync(join(dir, "auth.json"), authJson.endsWith("\n") ? authJson : `${authJson}\n`, { mode: 0o600 })
  } else if (authJsonPath && existsSync(authJsonPath)) {
    symlinkSync(authJsonPath, join(dir, "auth.json"))
  } else if (authJsonPath) {
    throw new Error(`[vitehub] Codex auth JSON path does not exist: ${authJsonPath}`)
  }
  return dir
}
