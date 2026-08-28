export const agentProviderCleanupTask: unique symbol = Symbol("vitehub.agent.providerCleanupTask")

export function createAgentProviderCredentialCleanup(
  persist: () => Promise<void>,
  remove: () => Promise<void>,
  release: () => void = () => undefined,
): { cleanup: () => Promise<void>, forceRemove: () => Promise<void> } {
  let cleanup: Promise<void> | undefined
  let removal: Promise<void> | undefined
  let forced = false
  let released = false
  const releaseOnce = () => {
    if (released) return
    released = true
    release()
  }
  const removeOnce = () => removal ??= remove().finally(releaseOnce)

  return {
    cleanup: () => cleanup ??= (async () => {
      try {
        if (!forced) await persist()
      }
      finally {
        if (!forced) await removeOnce()
        else {
          try {
            await removal
          }
          finally {
            await remove().finally(releaseOnce)
          }
        }
      }
    })(),
    forceRemove: () => {
      forced = true
      return removeOnce()
    },
  }
}

export async function settleAgentProviderCleanups(cleanups: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(cleanups)
  const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, "[vitehub] Provider Agent cleanup failed.")
}
