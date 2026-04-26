import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"

export function parseArgs(argv) {
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

export function getRequiredArg(args, name) {
  const value = args[name]
  if (typeof value === "string" && value.length > 0) {
    return value
  }

  throw new TypeError(`Missing required argument: --${name}`)
}

export function createMarker(prefix, suffix) {
  return `${prefix}-${suffix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export async function waitForHealth(url, timeoutMs) {
  const startedAt = Date.now()
  let lastError

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
      lastError = new Error(`Unexpected status from ${url}: ${response.status}`)
    }
    catch (error) {
      lastError = error
    }

    await sleep(2_000)
  }

  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${url}`)
}

export async function requestJson(url, init) {
  const response = await fetch(url, init)
  const bodyText = await response.text()
  let body
  try {
    body = bodyText ? JSON.parse(bodyText) : null
  }
  catch {
    body = bodyText
  }

  if (!response.ok) {
    throw new Error(`${init?.method || "GET"} ${url} failed with ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`)
  }

  return body
}

export async function verifyApp(url) {
  await waitForHealth(url, 60_000)
  const indexPayload = await requestJson(url)
  if (!indexPayload?.ok) {
    throw new Error(`Unexpected index payload: ${JSON.stringify(indexPayload)}`)
  }
}

export function createRunConfig(args, namespace) {
  const framework = typeof args.framework === "string" && args.framework.length > 0 ? args.framework : "vite"
  const provider = getRequiredArg(args, "provider")
  const url = getRequiredArg(args, "url")
  const timeoutMs = Number(args.timeout || 120_000)
  const markerPrefix = `vitehub-${namespace}-e2e-${framework}-${provider}`

  return {
    deferMarker: createMarker(markerPrefix, "defer"),
    directMarker: createMarker(markerPrefix, "direct"),
    framework,
    provider,
    timeoutMs,
    url,
  }
}

export async function runE2E({ namespace, dispatch, wait }) {
  const run = createRunConfig(parseArgs(process.argv.slice(2)), namespace)
  await verifyApp(run.url)

  const dispatched = await dispatch(run)
  await wait(run, dispatched)

  console.log(JSON.stringify({ ...run, ...(dispatched && typeof dispatched === "object" ? dispatched : {}), ok: true }))
}
