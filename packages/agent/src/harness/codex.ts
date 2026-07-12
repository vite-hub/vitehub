import { chmodSync, existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

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
    harness: createViteHubCodex({ ...settings, auth }),
    ...(sandboxProvider ? { sandbox: sandboxProvider } : {}),
  }
}

const codexBootstrapDir = "tmp/harness/codex"
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

function createViteHubCodex(settings: CodexHarnessSettings) {
  const harness = createCodex(settings)
  return {
    ...harness,
    async doStart(options: Parameters<typeof harness.doStart>[0]) {
      return await harness.doStart({
        ...options,
        sandboxSession: relativeCodexSandboxSession(options.sandboxSession),
      })
    },
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
          { content: bridge, path: `${codexBootstrapDir}/bridge.mjs` },
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

function relativeCodexSandboxSession<T extends object>(session: T, bootstrapDir?: string): T {
  const anchoredBootstrapDir = bootstrapDir ?? `${(session as T & { defaultWorkingDirectory: string }).defaultWorkingDirectory.replace(/\/+$/, "")}/${codexBootstrapDir}`
  return new Proxy(session, {
    get(target, property, receiver) {
      if (property === "restricted") {
        return () => relativeCodexSandboxSession((target as T & { restricted(): object }).restricted(), anchoredBootstrapDir)
      }
      if (property === "run" || property === "spawn") {
        return (options: { command: string }) => (target as T & Record<"run" | "spawn", (options: never) => unknown>)[property]({
          ...options,
          command: options.command.replaceAll("/tmp/harness/codex", anchoredBootstrapDir),
        } as never)
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
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
