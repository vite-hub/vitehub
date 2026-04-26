import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"

import { requestJson, runE2E } from "@vitehub/internal/test/e2e-live"

function createBody(marker, callbackUrl) {
  return JSON.stringify({ callbackUrl, email: "ava@example.com", marker })
}

async function dispatch(run) {
  const callbackUrl = new URL("/api/tests/queue", run.url).toString()
  const direct = requestJson(new URL("/api/queues/welcome", run.url), {
    body: createBody(run.directMarker, callbackUrl),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => {
    if (!response?.ok || !response?.result?.messageId) {
      throw new Error(`Unexpected direct queue response: ${JSON.stringify(response)}`)
    }
  })
  const defer = requestJson(new URL("/api/queues/welcome-defer", run.url), {
    body: createBody(run.deferMarker, callbackUrl),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => {
    if (!response?.ok) {
      throw new Error(`Unexpected deferred queue response: ${JSON.stringify(response)}`)
    }
  })
  await Promise.all([direct, defer])
}

async function waitForMarker(url, marker, timeoutMs) {
  const startedAt = Date.now()
  let lastSeen = false

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const payload = await requestJson(new URL(`/api/tests/queue?marker=${encodeURIComponent(marker)}`, url))
      if (payload?.ok && payload?.seen === true) {
        return
      }
      lastSeen = payload?.seen === true
    }
    catch {
      lastSeen = false
    }
    await sleep(1_000)
  }

  throw new Error(JSON.stringify({ marker, seen: lastSeen }))
}

async function wait(run) {
  const results = await Promise.allSettled([
    waitForMarker(run.url, run.directMarker, run.timeoutMs),
    waitForMarker(run.url, run.deferMarker, run.timeoutMs),
  ])
  const failures = results.filter(r => r.status === "rejected").map(r => r.reason instanceof Error ? r.reason.message : String(r.reason))
  if (failures.length) {
    throw new Error(`Queue markers were not observed: ${failures.join(", ")}`)
  }
}

runE2E({ namespace: "queue", dispatch, wait }).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
