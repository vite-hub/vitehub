import { chmodSync, existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { createCodex } from "@ai-sdk/harness-codex"

import { createLocalHarnessSandbox, type LocalHarnessSandboxOptions } from "./local-sandbox.ts"

import type { CodexHarnessSettings } from "@ai-sdk/harness-codex"
import type { AgentHarnessCredentialSource, AgentHarnessDriver, AgentHarnessSandboxProviderInput } from "../types.ts"

type CodexDriverSandboxOptions =
  | false
  | LocalHarnessSandboxOptions
  | AgentHarnessSandboxProviderInput

export interface CodexDriverOptions extends CodexHarnessSettings {
  authJson?: string
  authJsonPath?: string
  credentials?: AgentHarnessCredentialSource
  env?: Record<string, string | undefined>
  sandbox?: CodexDriverSandboxOptions
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
  const sandboxProvider = codexSandboxProvider({
    authJson,
    authJsonPath,
    env,
    preferOpenAI: defaultOpenAIAuth,
    sandbox,
  })

  return {
    credentials: credentials ?? { label: "Codex", source: "ambient" },
    harness: createCodex({ ...settings, auth }),
    ...(sandboxProvider ? { sandbox: sandboxProvider } : {}),
  }
}

function codexSandboxProvider(options: {
  authJson?: string
  authJsonPath?: string
  env?: Record<string, string | undefined>
  preferOpenAI: boolean
  sandbox?: CodexDriverSandboxOptions
}): AgentHarnessDriver["sandbox"] | undefined {
  const { sandbox } = options
  if (sandbox === false) return
  if (typeof sandbox === "function" || isHarnessSandboxProvider(sandbox)) return sandbox

  const localOptions = sandbox as LocalHarnessSandboxOptions | undefined
  return createLocalHarnessSandbox({
    ...localOptions,
    env: codexLocalEnv({
      authJson: options.authJson,
      authJsonPath: options.authJsonPath,
      env: {
        ...options.env,
        ...localOptions?.env,
      },
      preferOpenAI: options.preferOpenAI,
    }),
  })
}

function isHarnessSandboxProvider(value: unknown): value is AgentHarnessSandboxProviderInput {
  if (!value || typeof value !== "object") return false
  const provider = value as { createSession?: unknown, specificationVersion?: unknown }
  return typeof provider.createSession === "function" || provider.specificationVersion === "harness-sandbox-v1"
}

function codexLocalEnv(options: {
  authJson?: string
  authJsonPath?: string
  env?: Record<string, string | undefined>
  preferOpenAI: boolean
}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...options.env,
  }
  stripGitHubSecrets(env)

  if (options.preferOpenAI) {
    delete env.AI_GATEWAY_API_KEY
    delete env.AI_GATEWAY_BASE_URL
  }

  const codexHome = codexHomeFromAuth({
    authJson: options.authJson ?? env.CODEX_AUTH_JSON,
    authJsonPath: options.authJsonPath ?? env.CODEX_AUTH_JSON_PATH ?? ambientCodexAuthJsonPath(),
  })
  if (codexHome) env.CODEX_HOME = codexHome
  env.PATH = [
    join(process.cwd(), "node_modules", ".bin"),
    env.HOME ? join(env.HOME, ".local", "bin") : undefined,
    env.PATH,
  ].filter(Boolean).join(":")
  return env
}

function stripGitHubSecrets(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (/^(?:GITHUB|GH|VITEHUB_GITHUB)_/.test(key) && /(?:TOKEN|SECRET|PRIVATE_KEY|WEBHOOK|APP_ID)/.test(key)) {
      delete env[key]
    }
  }
}

function ambientCodexAuthJsonPath(): string | undefined {
  const path = join(homedir(), ".codex", "auth.json")
  return existsSync(path) ? path : undefined
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
