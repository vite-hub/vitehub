import { spawn } from "node:child_process"
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

function createQueueBody(marker) {
  return JSON.stringify({ email: "ava@example.com", marker })
}

function startCloudflareLogStream(workerName) {
  return spawn("npx", ["wrangler", "tail", workerName, "--format", "json", "--search", "vitehub-queue-e2e"], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function waitForProcessExit(child) {
  if (child.exitCode !== null) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    child.once("close", () => resolve())
  })
}

async function stopProcess(child, gracePeriodMs = 5_000) {
  if (child.exitCode !== null) {
    return
  }

  child.kill("SIGTERM")
  await Promise.race([waitForProcessExit(child), sleep(gracePeriodMs)])

  if (child.exitCode !== null) {
    return
  }

  child.kill("SIGKILL")
  await waitForProcessExit(child)
}

async function waitForCloudflareMarkers(workerName, markers, timeoutMs) {
  const logProcess = startCloudflareLogStream(workerName)
  let output = ""
  const capture = (chunk) => {
    output += chunk.toString()
  }

  logProcess.stdout.on("data", capture)
  logProcess.stderr.on("data", capture)

  try {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (markers.every(marker => output.includes(marker))) {
        return output
      }

      if (logProcess.exitCode !== null) {
        break
      }

      await sleep(1_000)
    }
  } finally {
    await stopProcess(logProcess)
  }

  throw new Error(`Timed out waiting for markers ${markers.join(", ")}.\n\nCaptured logs:\n${output}`)
}

async function waitForVercelMarkers(url, markers, timeoutMs) {
  const token = process.env.VERCEL_TOKEN
  if (!token) {
    throw new TypeError("Missing VERCEL_TOKEN.")
  }

  const deploymentHost = new URL(url).host
  const deploymentLookupUrl = new URL(`https://api.vercel.com/v13/deployments/${encodeURIComponent(deploymentHost)}`)
  if (typeof process.env.VERCEL_ORG_ID === "string" && process.env.VERCEL_ORG_ID.length > 0) {
    deploymentLookupUrl.searchParams.set("teamId", process.env.VERCEL_ORG_ID)
  }

  const deploymentResponse = await fetch(deploymentLookupUrl, {
    headers: {
      authorization: `Bearer ${token}`,
    },
  })

  if (!deploymentResponse.ok) {
    throw new Error(`Failed to resolve Vercel deployment: ${deploymentResponse.status} ${await deploymentResponse.text()}`)
  }

  const deployment = await deploymentResponse.json()
  const runtimeLogsUrl = new URL(`https://api.vercel.com/v1/projects/${deployment.projectId}/deployments/${deployment.id}/runtime-logs`)
  if (typeof process.env.VERCEL_ORG_ID === "string" && process.env.VERCEL_ORG_ID.length > 0) {
    runtimeLogsUrl.searchParams.set("teamId", process.env.VERCEL_ORG_ID)
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const runtimeLogsResponse = await fetch(runtimeLogsUrl, {
    headers: {
      authorization: `Bearer ${token}`,
    },
    signal: timeoutSignal,
  })

  if (!runtimeLogsResponse.ok || !runtimeLogsResponse.body) {
    throw new Error(`Failed to stream Vercel runtime logs: ${runtimeLogsResponse.status} ${await runtimeLogsResponse.text()}`)
  }

  const reader = runtimeLogsResponse.body.getReader()
  const decoder = new TextDecoder()
  let output = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      output += decoder.decode(value, { stream: true })
      if (markers.every(marker => output.includes(marker))) {
        return output
      }
    }
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new Error(`Timed out waiting for markers ${markers.join(", ")}.\n\nCaptured logs:\n${output}`)
    }
    throw error
  }

  throw new Error(`Stream closed before markers ${markers.join(", ")} were observed.\n\nCaptured logs:\n${output}`)
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
    worker: provider === "cloudflare" ? getRequiredArg(args, "worker") : undefined,
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

async function triggerQueue(url, marker) {
  const directResponse = await requestJson(new URL("/api/queues/welcome", url), {
    body: createQueueBody(marker),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  })

  if (!directResponse?.ok || !directResponse?.result?.messageId) {
    throw new Error(`Unexpected direct queue response: ${JSON.stringify(directResponse)}`)
  }
}

async function triggerDeferredQueue(url, marker) {
  const deferResponse = await requestJson(new URL("/api/queues/welcome-defer", url), {
    body: createQueueBody(marker),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  })

  if (!deferResponse?.ok) {
    throw new Error(`Unexpected deferred queue response: ${JSON.stringify(deferResponse)}`)
  }
}

async function waitForCompletion(run) {
  const markers = [run.directMarker, run.deferMarker]
  if (run.provider === "cloudflare") {
    return await waitForCloudflareMarkers(run.worker, markers, run.timeoutMs)
  }

  return await waitForVercelMarkers(run.url, markers, run.timeoutMs)
}

async function main() {
  const run = createRunConfig(parseArgs(process.argv.slice(2)))
  const pendingCompletion = waitForCompletion(run)

  await verifyApp(run.url)
  await triggerQueue(run.url, run.directMarker)
  await triggerDeferredQueue(run.url, run.deferMarker)
  await pendingCompletion

  console.log(JSON.stringify({ ...run, ok: true }))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
