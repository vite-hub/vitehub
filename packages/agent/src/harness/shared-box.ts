import type { Box, BoxOpenOptions, BoxSession } from "@vite-hub/box"

export const harnessBoxOpen = Symbol("vitehub.agent.harness-box-open")

export type SharedHarnessBox = Box & {
  [harnessBoxOpen](options?: BoxOpenOptions): Promise<BoxSession>
}

export async function openHarnessBox(box: Box, options?: BoxOpenOptions) {
  const shared = box as Partial<SharedHarnessBox>
  return shared[harnessBoxOpen]
    ? await shared[harnessBoxOpen](options)
    : await box.open(options)
}

export function shareBoxSessions(box: Box): SharedHarnessBox {
  let active: Promise<BoxSession> | undefined
  let initializing: BoxSession | undefined
  let harnessError: unknown
  let resolveHarness: (() => void) | undefined
  const harnessReady = new Promise<void>((resolve) => {
    resolveHarness = resolve
  })
  let leases = 0
  const lease = (session: BoxSession) => {
    leases++
    let closed = false
    return {
      ...session,
      async close() {
        if (closed) return
        closed = true
        leases--
        if (leases === 0) {
          const current = active
          active = undefined
          if (current) await (await current).close()
        }
      },
    }
  }
  return {
    plan: box.plan,
    async open(options) {
      if (initializing) {
        options?.signal?.throwIfAborted()
        return lease(initializing)
      }
      await harnessReady
      if (harnessError) throw harnessError
      options?.signal?.throwIfAborted()
      if (!active) throw new Error("[vitehub] The invocation Box session is already closed.")
      return lease(await active)
    },
    async [harnessBoxOpen](options) {
      if (!active) {
        let harnessLease: BoxSession | undefined
        active = box.open({
          ...options,
          ...(options?.initialize
            ? {
                async initialize(session, context) {
                  initializing = session
                  harnessLease = lease(session)
                  try {
                    await options.initialize!(harnessLease, context)
                  }
                  finally {
                    initializing = undefined
                  }
                },
              }
            : {}),
        })
        try {
          const session = await active
          resolveHarness?.()
          return harnessLease || lease(session)
        }
        catch (error) {
          leases = 0
          initializing = undefined
          active = undefined
          harnessError = error
          resolveHarness?.()
          throw error
        }
      }
      return lease(await active)
    },
  }
}
