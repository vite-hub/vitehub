import { sendBatchToPostHog } from "evlog/posthog"
import { PostHog } from "posthog-node"
import type { AgentEvlogExporter } from "../evlog.ts"

export interface AgentPostHogOptions {
  apiKey: string
  host?: string
  service: string
}

/** Node exporter for PostHog events, Error Tracking and evlog's official log drain. */
export function posthogAgentExporter(options: AgentPostHogOptions): AgentEvlogExporter {
  const host = options.host || "https://us.i.posthog.com"
  const endpoint = new URL("/batch/", host)
  if (!["https:", "http:"].includes(endpoint.protocol)) throw new TypeError("[vitehub] PostHog requires an HTTP(S) host.")
  if (!options.apiKey?.trim() || !options.service?.trim()) throw new TypeError("[vitehub] PostHog requires an API key and service.")

  async function acknowledged(message: Parameters<PostHog["captureImmediate"]>[0], signal?: AbortSignal) {
    const body = JSON.stringify({
      api_key: options.apiKey,
      batch: [{
        event: message.event, distinct_id: message.distinctId,
        uuid: message.uuid || crypto.randomUUID(), timestamp: (message.timestamp || new Date()).toISOString(),
        properties: { ...message.properties, $lib: "vitehub", $is_server: true, $geoip_disable: true, $process_person_profile: false },
      }],
    })
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted()
      let retryable = true
      try {
        const response = await fetch(endpoint, {
          method: "POST", headers: { "content-type": "application/json" }, body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000),
        })
        if (response.ok) {
          const result = await response.json() as { status?: unknown }
          if (result.status === "Ok" || result.status === 1) return
          retryable = false
        }
        else {
          retryable = response.status === 408 || response.status === 429 || response.status >= 500
          await response.body?.cancel()
        }
      }
      catch { /* The caller receives a failure without credential-bearing response content. */ }
      if (!retryable || attempt === 2) throw new Error("[vitehub] PostHog did not acknowledge event delivery.")
      await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)))
    }
  }

  // captureImmediate in SDK 5.51.6 suppresses transport failures. Preserve its
  // exception parser while requiring an acknowledgement for durable reports.
  class AcknowledgedPostHog extends PostHog {
    override captureImmediate(message: Parameters<PostHog["captureImmediate"]>[0]) { return acknowledged(message) }
  }
  const client = new AcknowledgedPostHog(options.apiKey, { host, disableGeoip: true, enableExceptionAutocapture: false, flushInterval: 0 })
  return {
    capture: (event, properties, delivery) => acknowledged({ distinctId: options.service, event, properties, uuid: delivery?.uuid, timestamp: delivery?.timestamp }, delivery?.signal),
    exception: (error, properties) => client.captureExceptionImmediate(error, options.service, properties),
    logs: events => sendBatchToPostHog(events, { apiKey: options.apiKey, host, timeout: 3000, retries: 2 }),
    flush: () => client.shutdown(10_000),
  }
}
