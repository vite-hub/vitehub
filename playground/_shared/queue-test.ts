type EventLike = {
  waitUntil?: (promise: Promise<unknown>) => void
  context?: {
    waitUntil?: (promise: Promise<unknown>) => void
    cloudflare?: {
      context?: { waitUntil?: (promise: Promise<unknown>) => void }
      waitUntil?: (promise: Promise<unknown>) => void
    }
    _platform?: {
      cloudflare?: {
        context?: { waitUntil?: (promise: Promise<unknown>) => void }
        waitUntil?: (promise: Promise<unknown>) => void
      }
    }
  }
  req?: {
    runtime?: {
      cloudflare?: {
        context?: { waitUntil?: (promise: Promise<unknown>) => void }
        waitUntil?: (promise: Promise<unknown>) => void
      }
    }
  }
}

const queueMarkerCallbackPath = "/api/tests/queue"

function bindWaitUntil(owner: { waitUntil?: (promise: Promise<unknown>) => void } | undefined) {
  return typeof owner?.waitUntil === "function" ? owner.waitUntil.bind(owner) : undefined
}

function resolveWaitUntil(event: EventLike) {
  return bindWaitUntil(event)
    || bindWaitUntil(event.context)
    || bindWaitUntil(event.context?.cloudflare)
    || bindWaitUntil(event.context?.cloudflare?.context)
    || bindWaitUntil(event.context?._platform?.cloudflare)
    || bindWaitUntil(event.context?._platform?.cloudflare?.context)
    || bindWaitUntil(event.req?.runtime?.cloudflare)
    || bindWaitUntil(event.req?.runtime?.cloudflare?.context)
}

export function runInBackground(event: EventLike, taskFactory: () => Promise<unknown>) {
  const waitUntil = resolveWaitUntil(event)
  if (!waitUntil) {
    return false
  }

  waitUntil(taskFactory().catch((error) => {
    console.error("[vitehub] Deferred queue dispatch failed", error)
  }))
  return true
}

export function resolveTrustedMarkerCallbackUrl(requestUrl: URL, callbackUrl: string | undefined) {
  if (!callbackUrl) {
    return undefined
  }

  const resolved = new URL(callbackUrl, requestUrl)
  if (resolved.origin !== requestUrl.origin || resolved.pathname !== queueMarkerCallbackPath) {
    return undefined
  }

  if (resolved.search || resolved.hash) {
    return undefined
  }

  return resolved.toString()
}

export type QueueMarkerStage = "received" | "done" | "failed" | "marker-write"

export const queueMarkerStages: readonly QueueMarkerStage[] = ["received", "done", "failed", "marker-write"]

export function getQueueMarkerKey(marker: string, stage: QueueMarkerStage) {
  return stage === "done" ? `queue-e2e:${marker}` : `queue-e2e:${marker}:${stage}`
}

export function getQueueMarkerValue(stage: QueueMarkerStage, error?: string) {
  return stage === "failed" || stage === "marker-write" ? error || "unknown error" : true
}

export async function reportQueueMarker(marker: string | undefined, callbackUrl: string | undefined, stage: QueueMarkerStage = "done", error?: string) {
  if (!marker || !callbackUrl) {
    return
  }

  const response = await fetch(callbackUrl, {
    body: JSON.stringify({ error, marker, stage }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  if (!response.ok) {
    throw new Error(`Marker callback for stage "${stage}" failed with ${response.status}.`)
  }
}

export async function reportQueueDelivery(payload: { callbackUrl?: string, marker?: string }) {
  try {
    await reportQueueMarker(payload.marker, payload.callbackUrl, "received")
    await reportQueueMarker(payload.marker, payload.callbackUrl, "done")
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await reportQueueMarker(payload.marker, payload.callbackUrl, "marker-write", message.slice(0, 500)).catch(() => {})
    throw error
  }
}
