import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { createCodex } from "@ai-sdk/harness-codex"

import { createLocalHarnessSandbox, type LocalHarnessSandboxOptions } from "./local-sandbox.ts"
import { adaptCodexHarnessSandbox, stripGatewaySecrets, stripGitHubSecrets } from "../internal/codex-sandbox.ts"

import type { CodexHarnessSettings } from "@ai-sdk/harness-codex"
import type {
  AgentHarnessDriver,
  AgentHarnessSandboxProviderInput,
  AgentInvocationContextValues,
  AgentRuntimeConfig,
  CodexDriverOptions,
  CodexDriverSandboxOptions,
} from "../types.ts"

const harnessSandboxAdapter = Symbol.for("vitehub.harnessSandboxAdapter")
const harnessGlobalSkillsDirectory = Symbol.for("vitehub.harnessGlobalSkillsDirectory")
const harnessSessionPrepare = Symbol.for("vitehub.harnessSessionPrepare")

export function createCodexDriver<CALL_OPTIONS = unknown, TOutput = unknown>(options: CodexDriverOptions<CALL_OPTIONS, TOutput> = {}): AgentHarnessDriver<AgentRuntimeConfig, CALL_OPTIONS, AgentInvocationContextValues, TOutput> {
  const {
    credentials,
    env,
    instructions,
    output,
    sandbox,
    workDir,
    ...settings
  } = options
  const defaultOpenAIAuth = settings.auth === undefined
  const auth = settings.auth ?? { openai: {} }
  // The upstream harness pins a model when this is undefined, which bypasses the operator's Codex profile.
  const model = settings.model ?? ""
  const sandboxProvider = codexSandboxProvider({
    env,
    preferOpenAI: defaultOpenAIAuth,
    sandbox,
  })

  return {
    credentials: credentials ?? { label: "Codex", source: "ambient" },
    harness: createViteHubCodex({ ...settings, auth, model }, defaultOpenAIAuth),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(output !== undefined ? { output } : {}),
    requires: [
      defaultOpenAIAuth ? { name: "Codex", command: "codex", args: ["login", "status"] } : "codex",
    ],
    ...(sandboxProvider ? { sandbox: sandboxProvider } : {}),
    ...(workDir !== undefined ? { workDir } : {}),
  }
}

const codexBootstrapDir = "/tmp/harness/codex"

function createViteHubCodex(settings: CodexHarnessSettings, preferOpenAI: boolean) {
  const harness = createCodex(settings)
  return {
    ...harness,
    [harnessGlobalSkillsDirectory]: (context: { box?: unknown }) => context.box
      ? ".codex/skills"
      : "tmp/harness/codex-home/skills",
    [harnessSessionPrepare]: async (session: object) => {
      await prepareCodexHome(session)
    },
    [harnessSandboxAdapter]: (
      provider: AgentHarnessSandboxProviderInput,
      options?: { box?: boolean, defaultSandbox?: boolean },
    ) => adaptCodexHarnessSandbox(provider, {
      defaultSandbox: options?.defaultSandbox,
      isolateHome: !options?.box,
      preferOpenAI,
    }),
    async getBootstrap() {
      const [pkg, lock, bridge] = await Promise.all([
        readCodexBridgeAsset("package.json"),
        readCodexBridgeAsset("pnpm-lock.yaml"),
        readCodexBridgeAsset("index.mjs"),
      ])
      return {
        bootstrapDir: codexBootstrapDir,
        commands: [
          { command: `mkdir -p ${codexBootstrapDir}` },
          { command: `if command -v corepack >/dev/null 2>&1 && corepack pnpm@10.33.2 --dir ${codexBootstrapDir} install --ignore-workspace --frozen-lockfile --store-dir ${codexBootstrapDir}/.pnpm-store; then :; else pnpm --dir ${codexBootstrapDir} install --ignore-workspace --frozen-lockfile --store-dir ${codexBootstrapDir}/.pnpm-store; fi` },
        ],
        files: [
          { content: pkg, path: `${codexBootstrapDir}/package.json` },
          { content: lock, path: `${codexBootstrapDir}/pnpm-lock.yaml` },
          { content: bridge, path: `${codexBootstrapDir}/bridge.mjs` },
        ],
        harnessId: "codex",
      }
    },
  }
}

async function readCodexBridgeAsset(name: string): Promise<string> {
  const packageEntry = createRequire(import.meta.url).resolve("@ai-sdk/harness-codex")
  return await readFile(fileURLToPath(new URL(`./bridge/${name}`, pathToFileURL(packageEntry))), "utf8")
}

async function prepareCodexHome(session: object): Promise<void> {
  const result = await (session as { run(options: { command: string, env?: Record<string, string | undefined> }): Promise<{ exitCode: number, stderr?: string }> }).run({
    command:
      'codex_home="${CODEX_HOME:-$HOME/.codex}" && ambient_home="$HOME/.codex" && mkdir -p "$codex_home" && chmod 700 "$codex_home" && if [ "$codex_home" != "$ambient_home" ] && [ -f "$ambient_home/auth.json" ] && [ ! -e "$codex_home/auth.json" ]; then cp "$ambient_home/auth.json" "$codex_home/auth.json" && chmod 600 "$codex_home/auth.json"; fi && if [ ! -e "$codex_home/config.toml" ]; then : > "$codex_home/config.toml"; fi && chmod 600 "$codex_home/config.toml"',
  })
  if (result.exitCode !== 0) {
    throw new Error(`[vitehub] Failed to prepare Codex Home: ${result.stderr || "sandbox command failed"}`)
  }
}

function codexSandboxProvider(options: {
  env?: Record<string, string | undefined>
  preferOpenAI: boolean
  sandbox?: CodexDriverSandboxOptions
}): AgentHarnessDriver["sandbox"] | undefined {
  const { sandbox } = options
  if (sandbox === false) return
  if (typeof sandbox === "function" || isHarnessSandboxProvider(sandbox)) return sandbox
  if (sandbox === undefined && options.env === undefined) return

  const localOptions = sandbox as LocalHarnessSandboxOptions | undefined
  return adaptCodexHarnessSandbox(createLocalHarnessSandbox({
    ...localOptions,
    env: codexLocalEnv({
      env: {
        ...options.env,
        ...localOptions?.env,
      },
      preferOpenAI: options.preferOpenAI,
    }),
  }))
}

function isHarnessSandboxProvider(value: unknown): value is AgentHarnessSandboxProviderInput {
  if (!value || typeof value !== "object") return false
  const provider = value as { createSession?: unknown, specificationVersion?: unknown }
  return typeof provider.createSession === "function" || provider.specificationVersion === "harness-sandbox-v1"
}

function codexLocalEnv(options: {
  env?: Record<string, string | undefined>
  preferOpenAI: boolean
}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...options.env,
  }
  stripGitHubSecrets(env)

  if (options.preferOpenAI) {
    stripGatewaySecrets(env)
  }

  env.PATH = [
    join(process.cwd(), "node_modules", ".bin"),
    env.HOME ? join(env.HOME, ".local", "bin") : undefined,
    env.PATH,
  ].filter(Boolean).join(":")
  return env
}
