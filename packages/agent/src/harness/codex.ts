import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { createCodex } from "@ai-sdk/harness-codex"

import { createLocalHarnessSandbox, type LocalHarnessSandboxOptions } from "./local-sandbox.ts"
import { adaptCodexHarnessSandbox, stripGatewaySecrets, stripGitHubSecrets } from "../internal/codex-sandbox.ts"

import type { CodexHarnessSettings } from "@ai-sdk/harness-codex"
import type {
  AgentHarnessCredentialSource,
  AgentHarnessDriver,
  AgentHarnessInstructions,
  AgentHarnessSandboxProviderInput,
  AgentHarnessWorkDir,
  AgentRuntimeConfig,
} from "../types.ts"

type CodexDriverSandboxOptions<CALL_OPTIONS = unknown> =
  | false
  | LocalHarnessSandboxOptions
  | AgentHarnessSandboxProviderInput<AgentRuntimeConfig, CALL_OPTIONS>

const harnessSandboxAdapter = Symbol.for("vitehub.harnessSandboxAdapter")
const harnessGlobalSkillsDirectory = Symbol.for("vitehub.harnessGlobalSkillsDirectory")
const harnessSessionPrepare = Symbol.for("vitehub.harnessSessionPrepare")

export interface CodexDriverOptions<CALL_OPTIONS = unknown> extends CodexHarnessSettings {
  credentials?: AgentHarnessCredentialSource
  env?: Record<string, string | undefined>
  instructions?: AgentHarnessInstructions<AgentRuntimeConfig, CALL_OPTIONS>
  sandbox?: CodexDriverSandboxOptions<CALL_OPTIONS>
  workDir?: AgentHarnessWorkDir<AgentRuntimeConfig, CALL_OPTIONS>
}

export function codexDriver<CALL_OPTIONS = unknown>(options: CodexDriverOptions<CALL_OPTIONS> = {}): AgentHarnessDriver<AgentRuntimeConfig, CALL_OPTIONS> {
  const {
    credentials,
    env,
    instructions,
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
    requires: [
      defaultOpenAIAuth ? { name: "Codex", command: "codex", args: ["login", "status"] } : "codex",
    ],
    ...(sandboxProvider ? { sandbox: sandboxProvider } : {}),
    ...(workDir !== undefined ? { workDir } : {}),
  }
}

const codexBootstrapDir = "/tmp/harness/codex"
const codexBridgeVersion = "0.144.1"
const codexBridgeLockReplacements = {
  "0.130.0": codexBridgeVersion,
  "sha512-ICKaZ5zrIDg71AiQcsUToVoe5Icmrc3LwSM5+2z7Cf8F1x6nOaY7/ucpFlr4aH8oDe7t3dangc+MsWZTkdvDFw==": "sha512-NVb1R5+QJBecLrLrtljHkS7djXu/fGWVaA0FUhop6KgPTdeDzvgMo9uhgAuLi+4mwgf29IhMyNGU/kHG3aV4NA==",
  "sha512-WGDj+RZ3TXWC/7MlwprgLWOqzpwatPIINPhP3IRzHA0ni+o3QZ4i4xrS2uWwGmHUJ395J5JHwoZAAZYyfJyz6w==": "sha512-Xir1zqPfpenhdoAoshN53uonzbBXj18COyzRkFlVZpSNyEl5XtkuYu9oddELePFN7K/0sXUcSO34Ad5IeCXPbw==",
  "sha512-R9pkGC7kwC8yQ8el5hvBlmugQlcsG/pHMEFgZluu03X9fD2TezGxdq3KqRDRCZuMYl07ILamVEoqknuJ0cq7MA==": "sha512-dABeDK+ATqMG54MGBd3VjpKfh5EOoqx9PKVQB2QYDaEXx3F6CdUCXue5QIMfr4OxziUj8pUcLAQyd+KFqiTUFw==",
  "sha512-gJ+7J8djevgtdra+NgDAiQQPW+O3KTsgGfE3E5dpDfww3zS5OCeV0V2dhxqnJdlOjOSDw99o0P2LqBv19mhpRw==": "sha512-K2g3Q3tNxzFhV0SuzO6HcsYK7EQrp/o4HyeReyhkwVrwwUPoYwyIbB0IRjHIiDzRhbKriDccid2iyF5aPqdTcg==",
  "sha512-tFtH0V9/hEI3d9y7zP92BXI9FM4Z3+STNQaOR52Czv18TRtCFUp7CbIUYaToopuq6UBfnE1VKr8RLhwT5FcbmA==": "sha512-451o15+XtaXCCb35t/KCyyPqXHnTPxPxtdqEYOnE3e4sH5AfnI/uVJwfdjOksMG6vRLy6R+fLvSDOMguRFLmQw==",
  "sha512-3VcNlez99xdnEf+kB1IOpWv9fICYV9PiGj4sLCO4TCcShLnyxe+YBGa3poknkvXLnMG0qiN9SMnYS2FGrMxQcA==": "sha512-HNGVI+BulrOaC/0IzBvd6EL62j7LrlbFKibrhw6hZjjCjAeUYzRB2jB4qDzXN1NfqDi6Xrvniof3kwbwab24lg==",
  "sha512-vdpmiNp57L/arZabltLXn8TyEtNa7W1meOEkr+3R6W/8ZyBt++wuqz1Orv134OT2grrcFJsIVCAIPiqUxCvBkA==": "sha512-L4aDVEh9o1u7WYoxpSyv3un9Bz26YZYocOFqE2oHdEQDL2s6/LdtutLQc3oUZruLlEbkNsjSU0HI1OKsP0+Ctg==",
  "sha512-FzMznm7fr5/nbjZgOujZ9Y9AbdGm7ji1FOoWiY3U+srqauvZaTgn6o6aCheSL7kuymu7nTLOO/cAyWV6NuesqQ==": "sha512-qv2HOp6v/nVP31p5I5GxYyL0wa79PMzim1+W9CKSV0UldjFV9AMbualA8PeXcYhbvvh9Y1UASXxwjuQdlyfAvw==",
} as const

function createViteHubCodex(settings: CodexHarnessSettings, preferOpenAI: boolean) {
  const harness = createCodex(settings)
  return {
    ...harness,
    [harnessGlobalSkillsDirectory]: (context: { box?: unknown }) => context.box
      ? "home/.codex/skills"
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
      const [pkg, lock, bridge, hostToolMcp] = await Promise.all([
        readCodexBridgeAsset("package.json"),
        readCodexBridgeAsset("pnpm-lock.yaml"),
        readCodexBridgeAsset("index.mjs"),
        readCodexBridgeAsset("host-tool-mcp.mjs"),
      ])
      const packageJson = JSON.parse(pkg) as { dependencies: Record<string, string> }
      packageJson.dependencies["@openai/codex-sdk"] = codexBridgeVersion
      return {
        bootstrapDir: codexBootstrapDir,
        commands: [
          { command: `mkdir -p ${codexBootstrapDir}` },
          { command: `if command -v corepack >/dev/null 2>&1 && corepack pnpm@10.33.2 --dir ${codexBootstrapDir} install --ignore-workspace --frozen-lockfile --store-dir ${codexBootstrapDir}/.pnpm-store; then :; else pnpm --dir ${codexBootstrapDir} install --ignore-workspace --frozen-lockfile --store-dir ${codexBootstrapDir}/.pnpm-store; fi` },
        ],
        files: [
          { content: `${JSON.stringify(packageJson, null, 2)}\n`, path: `${codexBootstrapDir}/package.json` },
          { content: replaceCodexBridgeLock(lock), path: `${codexBootstrapDir}/pnpm-lock.yaml` },
          { content: patchCodexBridge(bridge), path: `${codexBootstrapDir}/bridge.mjs` },
          { content: hostToolMcp, path: `${codexBootstrapDir}/host-tool-mcp.mjs` },
        ],
        harnessId: "codex",
      }
    },
  }
}

async function readCodexBridgeAsset(name: string): Promise<string> {
  const packageEntry = import.meta.resolve("@ai-sdk/harness-codex")
  return await readFile(fileURLToPath(new URL(`./bridge/${name}`, packageEntry)), "utf8")
}

function replaceCodexBridgeLock(lock: string): string {
  let result = lock
  for (const [from, to] of Object.entries(codexBridgeLockReplacements)) result = result.replaceAll(from, to)
  return result
}

function patchCodexBridge(bridge: string): string {
  const errorItemHandler = `  if (item.type === "error" && event.type === "item.completed") {
    ctx.send({
      type: "error",
      error: item.message ?? "codex item error"
    });
    return;
  }`
  const patched = bridge.replace(errorItemHandler, `  if (item.type === "error" && event.type === "item.completed") return;`)
  if (patched === bridge) throw new Error("[vitehub] The pinned Codex bridge error-item patch no longer applies.")
  return patched
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
