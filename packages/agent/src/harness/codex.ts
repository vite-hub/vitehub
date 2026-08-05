import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { createCodex } from "@ai-sdk/harness-codex"

import { createLocalHarnessSandbox, type LocalHarnessSandboxOptions } from "./local-sandbox.ts"
import { adaptCodexHarnessSandbox, codexBridgeNodeModulesEnv, stripGatewaySecrets, stripGitHubSecrets } from "../internal/codex-sandbox.ts"

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
const harnessInvocationSandboxAdapter = Symbol.for("vitehub.harnessInvocationSandboxAdapter")
const harnessGlobalSkillsDirectory = Symbol.for("vitehub.harnessGlobalSkillsDirectory")
const harnessSessionPrepare = Symbol.for("vitehub.harnessSessionPrepare")
export function createCodexDriver<CALL_OPTIONS = unknown, TOutput = unknown>(options: CodexDriverOptions<CALL_OPTIONS, TOutput> = {}): AgentHarnessDriver<AgentRuntimeConfig, CALL_OPTIONS, AgentInvocationContextValues, TOutput> {
  const {
    capacity,
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
    ...(capacity !== undefined ? { capacity } : {}),
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
const codexBridgeInstallCommand = `if command -v corepack >/dev/null 2>&1 && corepack pnpm@10.33.2 --dir ${codexBootstrapDir} install --ignore-workspace --frozen-lockfile --store-dir ${codexBootstrapDir}/.pnpm-store; then :; else pnpm --dir ${codexBootstrapDir} install --ignore-workspace --frozen-lockfile --store-dir ${codexBootstrapDir}/.pnpm-store; fi`
const codexBridgeNodeModules = `${codexBootstrapDir}/node_modules`
const codexBridgeDependencyMarker = "@openai/codex-sdk/package.json"
const codexBridgePrepareDependenciesCommand = [
  `codex_bridge_node_modules="\${${codexBridgeNodeModulesEnv}:-}"`,
  `if [ -z "$codex_bridge_node_modules" ]; then ${codexBridgeInstallCommand}`,
  `elif [ "\${codex_bridge_node_modules#/}" = "$codex_bridge_node_modules" ]; then printf '%s\\n' "[vitehub] ${codexBridgeNodeModulesEnv} must be an absolute sandbox path: $codex_bridge_node_modules" >&2; exit 1`,
  `elif [ ! -r "$codex_bridge_node_modules/${codexBridgeDependencyMarker}" ]; then printf '%s\\n' "[vitehub] ${codexBridgeNodeModulesEnv} must contain readable ${codexBridgeDependencyMarker}: $codex_bridge_node_modules" >&2; exit 1`,
  `elif [ "$codex_bridge_node_modules" = "${codexBridgeNodeModules}" ]; then :`,
  `elif [ -L "${codexBridgeNodeModules}" ]; then if [ "$(readlink "${codexBridgeNodeModules}")" != "$codex_bridge_node_modules" ]; then printf '%s\\n' "[vitehub] ${codexBridgeNodeModules} already links to a different dependency tree" >&2; exit 1; fi`,
  `elif [ -e "${codexBridgeNodeModules}" ]; then printf '%s\\n' "[vitehub] ${codexBridgeNodeModules} already exists and conflicts with ${codexBridgeNodeModulesEnv}" >&2; exit 1`,
  `else ln -s "$codex_bridge_node_modules" "${codexBridgeNodeModules}"`,
  "fi",
].join("; ")

function createViteHubCodex(settings: CodexHarnessSettings, preferOpenAI: boolean) {
  const harness = createCodex(settings)
  const adaptSandbox = (
    provider: AgentHarnessSandboxProviderInput,
    options?: { box?: boolean, defaultSandbox?: boolean, invocation?: { id: string, isolateBoxHome: boolean } },
  ) => adaptCodexHarnessSandbox(provider, {
    ...(options?.box && options.invocation?.isolateBoxHome
      ? { codexHomeRelativeToHome: `.vitehub/codex-home-${options.invocation.id}` }
      : {}),
    defaultSandbox: options?.defaultSandbox,
    isolateHome: !options?.box || options.invocation?.isolateBoxHome,
    preferOpenAI,
  })
  return {
    ...harness,
    [harnessGlobalSkillsDirectory]: (context: { box?: unknown }, invocation?: { id: string, isolateBoxHome: boolean }) => context.box
      ? invocation?.isolateBoxHome
        ? `.vitehub/codex-home-${invocation.id}/skills`
        : ".codex/skills"
      : "tmp/harness/codex-home/skills",
    [harnessSessionPrepare]: async (session: object, invocation?: { id: string, isolateBoxHome: boolean }) => {
      return await prepareCodexHome(session, invocation)
    },
    [harnessSandboxAdapter]: adaptSandbox,
    [harnessInvocationSandboxAdapter]: adaptSandbox,
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
          { command: codexBridgePrepareDependenciesCommand },
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

async function prepareCodexHome(session: object, invocation?: { id?: string, isolateBoxHome: boolean }): Promise<{ close: () => Promise<void> } | undefined> {
  const sandbox = session as { run(options: { command: string, env?: Record<string, string | undefined> }): Promise<{ exitCode: number, stderr?: string }> }
  const result = await sandbox.run({
    command:
      'codex_home="${CODEX_HOME:-$HOME/.codex}" && ambient_home="${VITEHUB_AMBIENT_CODEX_HOME:-$HOME/.codex}" && mkdir -p "$codex_home" && chmod 700 "$codex_home" && if [ "$codex_home" != "$ambient_home" ] && [ -d "$ambient_home" ]; then cp -R "$ambient_home"/. "$codex_home"; fi && rm -rf -- "$codex_home/skills/.git" && manifest="$codex_home/skills.vitehub-managed" && if [ -f "$manifest" ]; then while IFS= read -r managed || [ -n "$managed" ]; do case "$managed" in \'\'|*/*|.. ) exit 1 ;; esac; rm -rf -- "$codex_home/skills/$managed"; done < "$manifest" && rm -f -- "$manifest"; fi && manifest="$codex_home/skills/.vitehub-colocated" && if [ -f "$manifest" ]; then while IFS= read -r managed || [ -n "$managed" ]; do case "$managed" in \'\'|*/*|.. ) exit 1 ;; esac; rm -rf -- "$codex_home/skills/$managed"; done < "$manifest" && rm -f -- "$manifest"; fi && if [ ! -e "$codex_home/config.toml" ]; then : > "$codex_home/config.toml"; fi && chmod 600 "$codex_home/config.toml" && if [ "$codex_home" != "$ambient_home" ]; then baseline="$codex_home.vitehub-baseline" && rm -rf -- "$baseline" && mkdir -p "$baseline" && cp -R "$codex_home"/. "$baseline"; fi',
  })
  if (result.exitCode !== 0) {
    if (invocation?.isolateBoxHome && invocation.id) {
      await sandbox.run({ command: `rm -rf -- "$HOME/.vitehub/codex-home-${invocation.id}" "$HOME/.vitehub/codex-home-${invocation.id}.vitehub-baseline"` }).catch(() => undefined)
    }
    throw new Error(`[vitehub] Failed to prepare Codex Home: ${result.stderr || "sandbox command failed"}`)
  }
  if (!invocation?.isolateBoxHome || !invocation.id) return
  return {
    async close() {
      // Merge generated and modified Codex state without replaying unchanged seeded state.
      // Concurrent changes to the same path remain completion ordered; ambient-only entries are additive.
      const cleanup = await sandbox.run({
        command: `codex_home="$HOME/.vitehub/codex-home-${invocation.id}" && ambient_home="\${VITEHUB_AMBIENT_CODEX_HOME:-$HOME/.codex}" && baseline="$codex_home.vitehub-baseline" && status=0; rm -rf -- "$codex_home/skills/.git" || status=$?; for manifest in "$codex_home/skills.vitehub-managed" "$codex_home/skills/.vitehub-colocated"; do if [ -f "$manifest" ]; then while IFS= read -r managed || [ -n "$managed" ]; do case "$managed" in ''|*/*|.. ) status=1; break ;; esac; rm -rf -- "$codex_home/skills/$managed" || status=$?; done < "$manifest"; rm -f -- "$manifest" || status=$?; fi; done; if [ "$status" -eq 0 ] && [ -d "$baseline" ]; then find "$baseline" -type f -exec sh -c 'baseline="$1"; codex_home="$2"; shift 2; for seeded do relative="\${seeded#"$baseline"/}"; if cmp -s "$seeded" "$codex_home/$relative"; then rm -f -- "$codex_home/$relative" || exit $?; fi; done' sh "$baseline" "$codex_home" {} + || status=$?; fi; if [ "$status" -eq 0 ]; then rm -rf -- "$baseline" || status=$?; fi; if [ "$status" -eq 0 ]; then mkdir -p "$ambient_home" || status=$?; fi; if [ "$status" -eq 0 ]; then cp -R "$codex_home"/. "$ambient_home" || status=$?; fi; if [ "$status" -eq 0 ]; then rm -rf -- "$codex_home" || status=$?; fi; exit "$status"`,
      })
      if (cleanup.exitCode !== 0) {
        throw new Error(`[vitehub] Failed to preserve Codex state and remove the invocation Codex Home: ${cleanup.stderr || "sandbox command failed"}`)
      }
    },
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
