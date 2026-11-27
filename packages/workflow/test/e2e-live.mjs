import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"

import { requestJson, runE2E } from "@vite-hub/internal/test/e2e-live"

function post(url, path, body) {
  return requestJson(new URL(path, url), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

async function dispatch(run) {
  const callbackUrl = new URL("/api/tests/queue", run.url).toString()
  const [direct, defer] = await Promise.all([
    post(run.url, "/api/workflows/welcome", { callbackUrl, email: "ava@example.com", marker: run.directMarker }),
    post(run.url, "/api/workflows/welcome-defer", { callbackUrl, email: "ava@example.com", marker: run.deferMarker }),
  ])
  if (!direct?.ok || typeof direct?.result?.id !== "string") {
    throw new Error(`Unexpected /api/workflows/welcome response: ${JSON.stringify(direct)}`)
  }
  if (!defer?.ok) {
    throw new Error(`Unexpected /api/workflows/welcome-defer response: ${JSON.stringify(defer)}`)
  }
  return { directId: direct.result.id }
}

async function waitForRun(url, id, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastStatus = "unknown"

  while (Date.now() < deadline) {
    try {
      const payload = await requestJson(new URL(`/api/workflows/welcome/${encodeURIComponent(id)}`, url))
      if (payload?.status === "completed") {
        if (payload?.result?.marker !== marker) {
          throw new Error(`Workflow run ${id} completed with an unexpected result: ${JSON.stringify(payload.result)}`)
        }
        return
      }
      if (payload?.status === "failed") {
        throw new Error(`Workflow run ${id} failed: ${JSON.stringify(payload)}`)
      }
      lastStatus = payload?.status || "unknown"
    }
    catch (error) {
      if (error instanceof Error && error.message.startsWith(`Workflow run ${id} `)) throw error
      lastStatus = error instanceof Error ? error.message : String(error)
    }
    await sleep(1_000)
  }

  throw new Error(JSON.stringify({ id, status: lastStatus }))
}

async function waitForMarker(url, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const markerUrl = new URL(`/api/tests/queue?marker=${encodeURIComponent(marker)}`, url)
  let lastState = "not seen"

  while (Date.now() < deadline) {
    try {
      const payload = await requestJson(markerUrl, { signal: AbortSignal.timeout(5_000) })
      if (payload?.seen === true) return
      lastState = typeof payload?.error === "string" ? `step failed: ${payload.error}` : "not seen"
    }
    catch (error) {
      lastState = error instanceof Error ? error.message : String(error)
    }
    await sleep(1_000)
  }

  throw new Error(JSON.stringify({ marker, status: lastState }))
}

async function wait(run, dispatched) {
  const results = await Promise.allSettled([
    waitForRun(run.url, dispatched.directId, run.directMarker, run.timeoutMs),
    waitForMarker(run.url, run.deferMarker, run.timeoutMs),
  ])
  const failures = results.filter(r => r.status === "rejected").map(r => r.reason instanceof Error ? r.reason.message : String(r.reason))
  if (failures.length) {
    throw new Error(`Workflow runs did not complete: ${failures.join(", ")}`)
  }
}

runE2E({ namespace: "workflow", dispatch, wait }).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
