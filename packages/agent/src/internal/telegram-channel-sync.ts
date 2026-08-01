import type { AgentChannelSyncPlan, AgentChannelSyncProvider } from "./channel-sync.ts"

interface TelegramApiResponse<T> {
  description?: string
  ok: boolean
  result?: T
}

interface TelegramWebhookInfo {
  has_custom_certificate?: boolean
  ip_address?: string
  last_error_date?: number
  last_error_message?: string
  max_connections?: number
  pending_update_count?: number
  url?: string
}

interface TelegramChannelSyncOptions {
  apiBaseUrl?: string
  botToken: string
  mode: "disabled" | "webhook"
  secretToken?: string
}

function telegramApiUrl(options: TelegramChannelSyncOptions, method: string): string {
  const base = (options.apiBaseUrl || "https://api.telegram.org").replace(/\/+$/, "")
  return `${base}/bot${options.botToken}/${method}`
}

function redactTelegramDescription(
  description: string | undefined,
  options: TelegramChannelSyncOptions,
): string | undefined {
  let redacted = description?.trim()
  for (const secret of [options.botToken, options.secretToken]) {
    if (secret) redacted = redacted?.split(secret).join("[redacted]")
  }
  return redacted
}

async function telegramApi<T>(
  options: TelegramChannelSyncOptions,
  fetchImpl: typeof fetch,
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  let response: Response
  try {
    response = await fetchImpl(telegramApiUrl(options, method), {
      ...(body ? { body: JSON.stringify(body) } : {}),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    })
  }
  catch (error) {
    throw new Error(`Telegram ${method} request failed.`, { cause: error })
  }
  const result = (await response.json().catch(() => undefined)) as
    | TelegramApiResponse<T>
    | undefined
  if (!response.ok || !result?.ok || result.result === undefined) {
    const description = redactTelegramDescription(result?.description, options)
    throw new Error(
      `Telegram ${method} failed with HTTP ${response.status}${description ? `: ${description}` : ""}.`,
    )
  }
  return result.result as T
}

function telegramRemoteState(info: TelegramWebhookInfo): Record<string, unknown> {
  return {
    customCertificate: info.has_custom_certificate === true,
    ...(typeof info.ip_address === "string" ? { ipAddress: info.ip_address } : {}),
    ...(typeof info.last_error_date === "number"
      ? { lastErrorAt: new Date(info.last_error_date * 1000).toISOString() }
      : {}),
    ...(typeof info.last_error_message === "string"
      ? { lastErrorMessage: info.last_error_message }
      : {}),
    ...(typeof info.max_connections === "number" ? { maxConnections: info.max_connections } : {}),
    pendingUpdateCount:
      typeof info.pending_update_count === "number" ? info.pending_update_count : 0,
    url: typeof info.url === "string" ? info.url : "",
  }
}

async function inspectTelegramWebhook(
  options: TelegramChannelSyncOptions,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  return telegramRemoteState(
    await telegramApi<TelegramWebhookInfo>(options, fetchImpl, "getWebhookInfo"),
  )
}

export function createTelegramChannelSyncProvider(
  options: TelegramChannelSyncOptions,
): AgentChannelSyncProvider {
  if (options.secretToken && !/^[A-Za-z0-9_-]{1,256}$/.test(options.secretToken)) {
    throw new TypeError(
      "Telegram webhookSecret must be 1-256 letters, numbers, underscores, or hyphens.",
    )
  }
  return {
    mode: options.mode,
    resourceKey: options.botToken,
    async apply(plan, fetchImpl) {
      if (plan.action === "none") return plan.current
      if (plan.action === "delete") {
        await telegramApi<boolean>(options, fetchImpl, "deleteWebhook", {
          drop_pending_updates: false,
        })
      } else {
        const url = plan.desired.url
        if (typeof url !== "string" || !url)
          throw new TypeError("Telegram webhook synchronization requires a desired URL.")
        await telegramApi<boolean>(options, fetchImpl, "setWebhook", {
          allowed_updates: ["message"],
          drop_pending_updates: false,
          ...(options.secretToken ? { secret_token: options.secretToken } : {}),
          url,
        })
      }
      return await inspectTelegramWebhook(options, fetchImpl)
    },
    async plan({ desiredUrl, fetch, force }): Promise<AgentChannelSyncPlan> {
      const current = await inspectTelegramWebhook(options, fetch)
      const currentUrl = typeof current.url === "string" ? current.url : ""
      if (options.mode === "disabled") {
        return {
          action: currentUrl ? "delete" : "none",
          current,
          desired: { url: "" },
          ...(currentUrl ? { destructive: true } : {}),
        }
      }
      if (!desiredUrl)
        throw new TypeError("Telegram webhook synchronization requires a desired URL.")
      const target = new URL(desiredUrl)
      if (target.protocol !== "https:")
        throw new TypeError("Telegram webhooks require an HTTPS URL.")
      if (target.port && !["80", "88", "443", "8443"].includes(target.port)) {
        throw new TypeError("Telegram webhook URLs support ports 443, 80, 88, and 8443.")
      }
      return {
        action: force || currentUrl !== desiredUrl ? (currentUrl ? "update" : "create") : "none",
        current,
        desired: {
          allowedUpdates: ["message"],
          botToken: "configured",
          dropPendingUpdates: false,
          secretToken: options.secretToken ? "configured" : "not configured",
          url: desiredUrl,
        },
        unverifiable: ["allowedUpdates", "secretToken"],
      }
    },
  }
}
