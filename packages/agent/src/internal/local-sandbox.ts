import type { AgentHarnessDriver, AgentHarnessSandboxProviderInput } from "../types.ts"

export function adaptLocalHarnessSandbox(
  provider: AgentHarnessSandboxProviderInput,
  bootstrapDir: string,
): AgentHarnessDriver["sandbox"] {
  const adaptSession = <T extends object>(session: T, anchoredDir?: string): T => {
    const targetDir = anchoredDir ?? `${(session as T & { defaultWorkingDirectory: string }).defaultWorkingDirectory.replace(/\/+$/, "")}/${bootstrapDir.replace(/^\/+/, "")}`
    return new Proxy(session, {
      get(target, property, receiver) {
        if (property === "restricted") {
          return () => adaptSession((target as T & { restricted(): object }).restricted(), targetDir)
        }
        if (property === "run" || property === "spawn") {
          return (options: { command: string }) => (target as T & Record<"run" | "spawn", (options: never) => unknown>)[property]({
            ...options,
            command: options.command.replaceAll(bootstrapDir, targetDir),
          } as never)
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  }

  return {
    ...provider,
    async createSession(options = {}) {
      const onFirstCreate = (options as { onFirstCreate?: (session: object, context: { abortSignal?: AbortSignal }) => Promise<void> }).onFirstCreate
      const session = await (provider as { createSession(options: object): Promise<object> }).createSession({
        ...options,
        ...(onFirstCreate
          ? { onFirstCreate: async (session: object, context: { abortSignal?: AbortSignal }) => await onFirstCreate(adaptSession(session), context) }
          : {}),
      })
      return adaptSession(session)
    },
    ...("resumeSession" in provider && typeof provider.resumeSession === "function"
      ? {
          async resumeSession(options: { sessionId: string }) {
            return adaptSession(await (provider as { resumeSession(options: object): Promise<object> }).resumeSession(options))
          },
        }
      : {}),
  }
}
