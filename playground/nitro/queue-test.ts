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

export function runInBackground(event: EventLike, task: Promise<unknown>) {
  const waitUntil = resolveWaitUntil(event)
  if (!waitUntil) {
    return false
  }

  waitUntil(task.catch((error) => {
    console.error("[vitehub] Deferred queue dispatch failed", error)
  }))
  return true
}

export async function reportQueueMarker(marker: string | undefined, callbackUrl: string | undefined) {
  if (!marker || !callbackUrl) {
    return
  }

  const response = await fetch(callbackUrl, {
    body: JSON.stringify({ marker }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  if (!response.ok) {
    throw new Error(`Marker callback failed with ${response.status}.`)
  }
}
