import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"

import { requestJson, runE2E } from "@vitehub/internal/test/e2e-live"

function createBody(marker) {
  return JSON.stringify({ email: "ava@example.com", id: marker, marker })
}

async function trigger(url, path, marker) {
  const response = await requestJson(new URL(path, url), {
    body: createBody(marker),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
  if (!response?.ok || !response?.result?.id) {
    throw new Error(`Unexpected ${path} response: ${JSON.stringify(response)}`)
  }
  return response.result.id
}

async function dispatch(run) {
  const [directId, deferId] = await Promise.all([
    trigger(run.url, "/api/workflows/welcome", run.directMarker),
    trigger(run.url, "/api/workflows/welcome-defer", run.deferMarker),
  ])
  return { deferId, directId }
}

async function waitForRun(url, id, timeoutMs) {
  const startedAt = Date.now()
  let lastStatus = "unknown"

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const payload = await requestJson(new URL(`/api/workflows/welcome/${encodeURIComponent(id)}`, url))
      if (payload?.status === "completed") {
        return
      }
      if (payload?.status === "failed") {
        throw new Error(`Workflow run ${id} failed: ${JSON.stringify(payload)}`)
      }
      lastStatus = payload?.status || "unknown"
    }
    catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error)
    }
    await sleep(1_000)
  }

  throw new Error(JSON.stringify({ id, status: lastStatus }))
}

async function wait(run, dispatched) {
  const results = await Promise.allSettled([
    waitForRun(run.url, dispatched.directId, run.timeoutMs),
    waitForRun(run.url, dispatched.deferId, run.timeoutMs),
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
