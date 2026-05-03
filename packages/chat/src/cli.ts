#!/usr/bin/env node
import { readFile } from "node:fs/promises"
import process from "node:process"
import { pathToFileURL } from "node:url"

export interface TelegramWebhookCliIO {
  cwd?: string
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
  stderr?: Pick<typeof process.stderr, "write">
  stdout?: Pick<typeof process.stdout, "write">
}

const defaultTelegramApiBaseUrl = "https://api.telegram.org"
const defaultTelegramWebhookRoute = "/api/webhooks/telegram"

export async function main(argv: string[] = process.argv.slice(2), io: TelegramWebhookCliIO = {}): Promise<number> {
  const stdout = io.stdout || process.stdout
  const stderr = io.stderr || process.stderr

  try {
    const env = await loadEnv(io.cwd || process.cwd(), io.env || process.env)
    const [scope, resource, command, ...rest] = argv
    if (scope !== "telegram" || resource !== "webhook") {
      throw new Error(usage())
    }

    if (command === "set") {
      const { route, workerUrl } = parseSetWebhookArgs(rest)
      const result = await setTelegramWebhook(workerUrl, { env, fetch: io.fetch, route })
      stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return 0
    }

    if (command === "info") {
      const result = await callTelegram("getWebhookInfo", {}, { env, fetch: io.fetch })
      stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return 0
    }

    throw new Error(usage())
  }
  catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

export async function loadEnv(cwd: string, baseEnv: Record<string, string | undefined> = process.env): Promise<Record<string, string | undefined>> {
  const values = { ...baseEnv }

  try {
    const contents = await readFile(`${cwd}/.env`, "utf8")
    for (const line of contents.split(/\r?\n/)) {
      const separator = line.indexOf("=")
      if (separator === -1) continue

      const key = line.slice(0, separator).trim()
      if (!isEnvKey(key)) continue

      values[key] ??= parseEnvValue(line.slice(separator + 1).trim())
    }
  }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }

  return values
}

export function createTelegramWebhookUrl(workerUrl: string, route: string = defaultTelegramWebhookRoute): string {
  if (!workerUrl) throw new Error("Missing Worker URL.")
  return new URL(route, workerUrl).toString()
}

function parseSetWebhookArgs(args: string[]) {
  let route = defaultTelegramWebhookRoute
  let workerUrl: string | undefined

  for (let index = 0; index < args.length; index++) {
    const value = args[index]
    if (value === "--route") {
      route = args[index + 1] || ""
      index += 1
      continue
    }
    if (!workerUrl) {
      workerUrl = value
      continue
    }
    throw new Error(usage())
  }

  if (!workerUrl) throw new Error(`Missing Worker URL.\n${usage()}`)
  return { route, workerUrl }
}

async function setTelegramWebhook(
  workerUrl: string,
  options: { env: Record<string, string | undefined>, fetch?: typeof fetch, route?: string },
) {
  const secretToken = options.env.TELEGRAM_WEBHOOK_SECRET_TOKEN
  if (!secretToken) throw new Error("Missing TELEGRAM_WEBHOOK_SECRET_TOKEN.")

  return await callTelegram("setWebhook", {
    secret_token: secretToken,
    url: createTelegramWebhookUrl(workerUrl, options.route),
  }, options)
}

async function callTelegram(
  method: "getWebhookInfo" | "setWebhook",
  payload: Record<string, unknown>,
  options: { env: Record<string, string | undefined>, fetch?: typeof fetch },
) {
  const token = options.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN.")

  const fetcher = options.fetch || fetch
  const apiBaseUrl = trimTrailingSlash(options.env.TELEGRAM_API_BASE_URL || defaultTelegramApiBaseUrl)
  const response = await fetcher(`${apiBaseUrl}/bot${token}/${method}`, {
    body: JSON.stringify(payload),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  })
  const data = await response.json() as { ok?: boolean }

  if (!response.ok || !data.ok) {
    throw new Error(JSON.stringify(data, null, 2))
  }

  return data
}

function isEnvKey(value: string) {
  return /^\w+$/u.test(value) && !/^\d/u.test(value)
}

function parseEnvValue(value: string) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed.replace(/\s+#.*$/, "")
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "")
}

function usage() {
  return [
    "Usage:",
    "  vitehub-chat telegram webhook set <worker-url> [--route /api/webhooks/telegram]",
    "  vitehub-chat telegram webhook info",
  ].join("\n")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
