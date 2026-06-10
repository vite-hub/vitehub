import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"

import { requestJson, runE2E } from "@vite-hub/internal/test/e2e-live"

async function dispatchProviderSchedule(run) {
  if (run.provider !== "vercel") {
    return undefined
  }
  const startedAt = Date.now()
  const url = new URL("/api/vitehub/schedules/vercel/daily-marker", run.url)
  const response = await fetch(url, { method: "POST" })
  if (!response.ok) {
    throw new Error(`POST ${url} failed with ${response.status}: ${await response.text()}`)
  }
  return { dispatched: true, startedAt }
}

async function waitForSchedule(run, dispatched) {
  const startedAt = typeof dispatched?.startedAt === "number" ? dispatched.startedAt : Date.now()
  const startedAtIso = new Date(startedAt).toISOString()
  let attempts = 0
  let lastPayload
  let lastError

  while (Date.now() - startedAt < run.timeoutMs) {
    attempts += 1
    try {
      const payload = await requestJson(new URL("/api/tests/schedule", run.url))
      lastPayload = payload
      const ranAt = typeof payload?.marker?.ranAt === "string" ? Date.parse(payload.marker.ranAt) : Number.NaN
      if (
        payload?.ok
        && payload?.seen === true
        && payload?.marker?.provider === run.provider
        && payload?.marker?.schedule === "daily-marker"
        && ranAt >= startedAt
      ) {
        return
      }
    }
    catch (error) {
      lastError = error
    }

    await sleep(5_000)
  }

  throw new Error(`Schedule marker was not observed before timeout: ${JSON.stringify({
    attempts,
    lastError: lastError instanceof Error ? lastError.message : lastError ? String(lastError) : undefined,
    lastPayload,
    provider: run.provider,
    startedAt: startedAtIso,
    timeoutMs: run.timeoutMs,
    url: new URL("/api/tests/schedule", run.url).toString(),
  })}`)
}

runE2E({ namespace: "schedule", dispatch: dispatchProviderSchedule, wait: waitForSchedule }).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
