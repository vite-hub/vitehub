import type { AgentHarnessDriver, AgentHarnessSandboxProviderInput } from "../types.ts"

const codexSandboxAdapterApplied = Symbol("vitehub.codexSandboxAdapterApplied")
const absoluteCodexBootstrapDir = "/tmp/harness/codex"
const localCodexBootstrapDir = "tmp/harness/codex"
export const codexBridgeNodeModulesEnv = "VITEHUB_CODEX_BRIDGE_NODE_MODULES"

function relativeCodexSandboxSession<T extends object>(session: T, isolateHome: boolean, rootEnvironmentPaths: boolean, bootstrapDir?: string, codexHome?: string): T {
  const defaultWorkingDirectory = bootstrapDir && codexHome
    ? undefined
    : (session as T & { defaultWorkingDirectory: string }).defaultWorkingDirectory.replace(/\/+$/, "")
  const anchoredBootstrapDir = bootstrapDir ?? `${defaultWorkingDirectory}/${localCodexBootstrapDir}`
  const anchoredCodexHome = codexHome ?? `${defaultWorkingDirectory}/tmp/harness/codex-home`
  const env = (session as T & { env?: Record<string, string | undefined> }).env
  const bridgeNodeModules = env?.[codexBridgeNodeModulesEnv]
  if (env && rootEnvironmentPaths && defaultWorkingDirectory && bridgeNodeModules?.startsWith("/")) {
    env[codexBridgeNodeModulesEnv] = bridgeNodeModules === defaultWorkingDirectory || bridgeNodeModules.startsWith(`${defaultWorkingDirectory}/`)
      ? bridgeNodeModules
      : `${defaultWorkingDirectory}/${bridgeNodeModules.replace(/^\/+/, "")}`
  }
  return new Proxy(session, {
    get(target, property, receiver) {
      if (property === "restricted") {
        return () => relativeCodexSandboxSession((target as T & { restricted(): object }).restricted(), isolateHome, rootEnvironmentPaths, anchoredBootstrapDir, anchoredCodexHome)
      }
      if (property === "run" || property === "spawn") {
        return (options: { command: string, env?: Record<string, string | undefined> }) => (target as T & Record<"run" | "spawn", (options: never) => unknown>)[property]({
          ...options,
          command: options.command.replaceAll(absoluteCodexBootstrapDir, anchoredBootstrapDir),
          ...(isolateHome ? { env: { ...options.env, CODEX_HOME: anchoredCodexHome } } : {}),
        } as never)
      }
      if (property === "readTextFile" || property === "writeTextFile") {
        return (options: { path: string }) => (target as T & Record<"readTextFile" | "writeTextFile", (options: never) => unknown>)[property]({
          ...options,
          path: options.path.replaceAll(absoluteCodexBootstrapDir, anchoredBootstrapDir),
        } as never)
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

export function adaptCodexHarnessSandbox(
  provider: AgentHarnessSandboxProviderInput,
  options: { defaultSandbox?: boolean, isolateHome?: boolean, preferOpenAI?: boolean } = {},
): AgentHarnessDriver["sandbox"] {
  if ((provider as Record<PropertyKey, unknown>)[codexSandboxAdapterApplied]) return provider
  const rootEnvironmentPaths = (provider as { providerId?: string }).providerId === "local"
  const adaptSession = (session: object) => {
    if ("env" in session && session.env && typeof session.env === "object") {
      const env = session.env as Record<string, string | undefined>
      if (options.defaultSandbox) stripGitHubSecrets(env)
      if (options.preferOpenAI) stripGatewaySecrets(env)
    }
    return relativeCodexSandboxSession(session, options.isolateHome !== false, rootEnvironmentPaths)
  }
  return {
    ...provider,
    [codexSandboxAdapterApplied]: true,
    async createSession(createOptions: { onFirstCreate?: (session: object, context: { abortSignal?: AbortSignal }) => Promise<void> } = {}) {
      const onFirstCreate = createOptions.onFirstCreate
      const session = await (provider as { createSession(options: object): Promise<object> }).createSession({
        ...createOptions,
        ...(onFirstCreate
          ? { onFirstCreate: async (session: object, context: { abortSignal?: AbortSignal }) => await onFirstCreate(adaptSession(session), context) }
          : {}),
      })
      return adaptSession(session)
    },
    ...("resumeSession" in provider && typeof provider.resumeSession === "function"
      ? {
          async resumeSession(options: { sessionId: string }) {
            const session = await (provider as { resumeSession(options: object): Promise<object> }).resumeSession(options)
            return adaptSession(session)
          },
        }
      : {}),
  }
}

export function stripGatewaySecrets(env: Record<string, string | undefined>): void {
  delete env.AI_GATEWAY_API_KEY
  delete env.AI_GATEWAY_BASE_URL
}

export function stripGitHubSecrets(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (/^(?:GITHUB|GH|VITEHUB_GITHUB)_/.test(key) && /(?:TOKEN|SECRET|PRIVATE_KEY|WEBHOOK|APP_ID)/.test(key)) delete env[key]
  }
}
