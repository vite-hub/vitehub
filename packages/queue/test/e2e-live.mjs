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

function createQueueBody(marker, callbackUrl) {
  return JSON.stringify({ callbackUrl, email: "ava@example.com", marker })
}

function createRunConfig(args) {
  const framework = typeof args.framework === "string" && args.framework.length > 0 ? args.framework : "vite"
  const provider = getRequiredArg(args, "provider")
  const url = getRequiredArg(args, "url")
  const timeoutMs = Number(args.timeout || 120_000)
  const markerPrefix = `vitehub-queue-e2e-${framework}-${provider}`

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

async function triggerQueue(url, marker, callbackUrl) {
  const directResponse = await requestJson(new URL("/api/queues/welcome", url), {
    body: createQueueBody(marker, callbackUrl),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  })

  if (!directResponse?.ok || !directResponse?.result?.messageId) {
    throw new Error(`Unexpected direct queue response: ${JSON.stringify(directResponse)}`)
  }
}

async function triggerDeferredQueue(url, marker, callbackUrl) {
  const deferResponse = await requestJson(new URL("/api/queues/welcome-defer", url), {
    body: createQueueBody(marker, callbackUrl),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  })

  if (!deferResponse?.ok) {
    throw new Error(`Unexpected deferred queue response: ${JSON.stringify(deferResponse)}`)
  }
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
    } catch {
      lastSeen = false
    }

    await sleep(1_000)
  }

  throw new Error(JSON.stringify({ marker, seen: lastSeen }))
}

async function waitForCompletion(run) {
  const failures = []

  for (const marker of [run.directMarker, run.deferMarker]) {
    try {
      await waitForMarker(run.url, marker, run.timeoutMs)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }

  if (failures.length > 0) {
    throw new Error(`Queue markers were not observed: ${failures.join(", ")}`)
  }
}

async function main() {
  const run = createRunConfig(parseArgs(process.argv.slice(2)))
  const callbackUrl = new URL("/api/tests/queue", run.url).toString()

  await verifyApp(run.url)
  const pendingCompletion = waitForCompletion(run)
  await triggerQueue(run.url, run.directMarker, callbackUrl)
  await triggerDeferredQueue(run.url, run.deferMarker, callbackUrl)
  await pendingCompletion

  console.log(JSON.stringify({ ...run, ok: true }))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
