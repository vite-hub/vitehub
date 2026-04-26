import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value?.startsWith("--")) {
      continue
    }

    const key = value.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) {
      args[key] = true
      continue
    }

    args[key] = next
    index += 1
  }

  return args
}

function getRequiredArg(args, name) {
  const value = args[name]
  if (typeof value === "string" && value.length > 0) {
    return value
  }

  throw new TypeError(`Missing required argument: --${name}`)
}

function createMarker(prefix, suffix) {
  return `${prefix}-${suffix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

async function waitForHealth(url, timeoutMs) {
  const startedAt = Date.now()
  let lastError

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }

      lastError = new Error(`Unexpected status from ${url}: ${response.status}`)
    } catch (error) {
      lastError = error
    }

    await sleep(2_000)
  }

  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${url}`)
}

async function requestJson(url, init) {
  const response = await fetch(url, init)
  const bodyText = await response.text()
  let body
  try {
    body = bodyText ? JSON.parse(bodyText) : null
  } catch {
    body = bodyText
  }

  if (!response.ok) {
    throw new Error(`${init?.method || "GET"} ${url} failed with ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`)
  }

  return body
}

function createWorkflowBody(marker) {
  return JSON.stringify({ email: "ava@example.com", id: marker, marker })
}

function createRunConfig(args) {
  const framework = typeof args.framework === "string" && args.framework.length > 0 ? args.framework : "vite"
  const provider = getRequiredArg(args, "provider")
  const url = getRequiredArg(args, "url")
  const timeoutMs = Number(args.timeout || 120_000)
  const markerPrefix = `vitehub-workflow-e2e-${framework}-${provider}`

  return {
    deferMarker: createMarker(markerPrefix, "defer"),
    directMarker: createMarker(markerPrefix, "direct"),
    framework,
    provider,
    timeoutMs,
    url,
  }
}

async function verifyApp(url) {
  await sleep(5_000)
  await waitForHealth(url, 60_000)

  const indexPayload = await requestJson(url)
  if (!indexPayload?.ok) {
    throw new Error(`Unexpected index payload: ${JSON.stringify(indexPayload)}`)
  }
}

async function triggerWorkflow(url, marker) {
  const directResponse = await requestJson(new URL("/api/workflows/welcome", url), {
    body: createWorkflowBody(marker),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  })

  if (!directResponse?.ok || !directResponse?.result?.id) {
    throw new Error(`Unexpected direct workflow response: ${JSON.stringify(directResponse)}`)
  }

  return directResponse.result.id
}

async function triggerDeferredWorkflow(url, marker) {
  const deferResponse = await requestJson(new URL("/api/workflows/welcome-defer", url), {
    body: createWorkflowBody(marker),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  })

  if (!deferResponse?.ok || !deferResponse?.result?.id) {
    throw new Error(`Unexpected deferred workflow response: ${JSON.stringify(deferResponse)}`)
  }

  return deferResponse.result.id
}

async function waitForWorkflowRun(url, id, timeoutMs) {
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
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error)
    }

    await sleep(1_000)
  }

  throw new Error(JSON.stringify({ id, status: lastStatus }))
}

async function waitForCompletion(run, ids) {
  const failures = []

  for (const id of ids) {
    try {
      await waitForWorkflowRun(run.url, id, run.timeoutMs)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }

  if (failures.length > 0) {
    throw new Error(`Workflow runs did not complete: ${failures.join(", ")}`)
  }
}

async function main() {
  const run = createRunConfig(parseArgs(process.argv.slice(2)))

  await verifyApp(run.url)
  const directId = await triggerWorkflow(run.url, run.directMarker)
  const deferId = await triggerDeferredWorkflow(run.url, run.deferMarker)
  await waitForCompletion(run, [directId, deferId])

  console.log(JSON.stringify({ ...run, deferId, directId, ok: true }))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
