import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"

import { requestJson, runE2E } from "@vitehub/internal/test/e2e-live"

async function dispatch() {
  return undefined
}

async function waitForSchedule(run) {
  const startedAt = Date.now()
  let attempts = 0
  let lastPayload
  let lastError

  while (Date.now() - startedAt < run.timeoutMs) {
    attempts += 1
    try {
      const payload = await requestJson(new URL("/api/tests/schedule", run.url))
      lastPayload = payload
      if (payload?.ok && payload?.seen === true && payload?.marker?.schedule === "daily-marker") {
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
    framework: run.framework,
    lastError: lastError instanceof Error ? lastError.message : lastError ? String(lastError) : undefined,
    lastPayload,
    provider: run.provider,
    timeoutMs: run.timeoutMs,
    url: new URL("/api/tests/schedule", run.url).toString(),
  })}`)
}

runE2E({ namespace: "schedule", dispatch, wait: waitForSchedule }).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
