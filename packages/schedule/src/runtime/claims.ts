import type { Lease, LeaseStore } from "@vite-hub/runtime"

export interface OccurrenceClaimsOptions {
  /**
   * Milliseconds after the end of a run that its done marker lasts. Make it longer than the catch-up window, so that a
   * process that starts later does not run the occurrence again.
   */
  doneTtlMs: number
  leases: LeaseStore
  /** A label for the holder, such as `host:pid`. It is for inspection only. */
  owner?: string
  /** Namespace shared by the servers of one app. Defaults to `vitehub:schedule`. */
  prefix?: string
  reportError(error: unknown): void
  /** Milliseconds that a claim lasts when its process stops renewing it, for example after a crash. */
  ttlMs: number
}

/** `held` when another process holds the occurrence now, `done` when a process finished it, `ran` when this call ran it. */
export type OccurrenceClaimResult = "done" | "held" | "ran"

/** Runs each Schedule occurrence in one process of all the processes that share `leases`. */
export interface OccurrenceClaims {
  /**
   * Runs `run` when this process gets the claim on `runId` and no process finished it. While `run` works, the claim is
   * renewed. Call `markFinal` before invoking the handler or when an existing run is final. Then a done marker stays
   * for `doneTtlMs`, also when the handler throws. Errors before `markFinal` leave the occurrence retryable.
   */
  run(runId: string, run: (markFinal: () => void) => Promise<unknown>): Promise<OccurrenceClaimResult>
}

/** The lease key of one occurrence within an app's Schedule prefix. */
export function occurrenceLeaseKey(runId: string, prefix = "vitehub:schedule"): string {
  const base = prefix.replace(/^\/+|\/+$/g, "")
  return `${base ? `${base}/` : ""}schedule/${runId}`
}

/** The lease key that marks an occurrence as finished. */
export function occurrenceDoneKey(runId: string, prefix?: string): string {
  return `${occurrenceLeaseKey(runId, prefix)}/done`
}

function keepAlive(lease: Lease, ttlMs: number, reportError: (error: unknown) => void): () => Promise<void> {
  let stopped = false
  let renewal: Promise<void> | undefined
  const timer = setInterval(() => {
    if (renewal) return
    renewal = lease.renew().then(([error, renewed]) => {
      if (stopped) return
      if (error) reportError(error)
      else if (!renewed) reportError(new Error(`[vitehub] Schedule occurrence claim "${lease.key}" ended before its run finished. Another process can run it too. Make the claim TTL longer than a pause of this process.`))
    }, error => { if (!stopped) reportError(error) }).finally(() => { renewal = undefined })
  }, Math.max(1, Math.floor(ttlMs / 3)))
  timer.unref?.()
  return async () => {
    stopped = true
    clearInterval(timer)
    // Finish an earlier renewal before extending the claim to cover a failed done-marker write.
    await renewal
  }
}

export function createOccurrenceClaims(options: OccurrenceClaimsOptions): OccurrenceClaims {
  const ttl = options.ttlMs / 1000
  const doneTtl = options.doneTtlMs / 1000
  const owner = options.owner === undefined ? {} : { owner: options.owner }
  return {
    async run(runId, run) {
      const [acquireError, lease] = await options.leases.acquire(occurrenceLeaseKey(runId, options.prefix), { ttl, ...owner })
      if (acquireError) throw acquireError
      if (!lease) return "held"
      let release = true
      try {
        const [doneError, done] = await options.leases.get(occurrenceDoneKey(runId, options.prefix))
        if (doneError) throw doneError
        if (done) return "done"
        const stop = keepAlive(lease, options.ttlMs, options.reportError)
        let final = false
        try {
          await run(() => { final = true })
        }
        finally {
          await stop()
          if (final) {
            const [markError, marked] = await options.leases.acquire(occurrenceDoneKey(runId, options.prefix), { ttl: doneTtl, ...owner })
            if (markError) {
              // Keep the claim for the same window as the missing marker. Renew checks the holder's ID.
              release = false
              options.reportError(markError)
              const [renewError, renewed] = await lease.renew({ ttl: doneTtl })
              if (renewError) options.reportError(renewError)
              else if (!renewed) options.reportError(new Error(`[vitehub] Schedule occurrence "${runId}" lost its claim before its done marker could be saved. Another process can run it too.`))
            }
            else if (!marked) options.reportError(new Error(`[vitehub] Schedule occurrence "${runId}" already had a done marker. Two processes ran it.`))
          }
        }
        return "ran"
      }
      finally {
        // A failed release leaves the claim until its TTL ends. The done marker already stops a second run.
        if (release) {
          const [releaseError] = await lease.release()
          if (releaseError) options.reportError(releaseError)
        }
      }
    },
  }
}
