import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { describe, expect, it, vi } from "vitest"

import { createTelegramWebhookUrl, isCliEntrypoint, loadEnv, main } from "../src/cli.ts"

function createWriter() {
  let output = ""
  return {
    stream: {
      write(chunk: string) {
        output += chunk
        return true
      },
    },
    output: () => output,
  }
}

describe("vitehub-chat CLI", () => {
  it("loads .env values without overriding the process environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vitehub-chat-cli-"))
    await writeFile(join(dir, ".env"), [
      "TELEGRAM_BOT_TOKEN=from-file",
      "TELEGRAM_WEBHOOK_SECRET_TOKEN='secret value'",
      "TELEGRAM_API_BASE_URL=https://telegram.example.test # comment",
    ].join("\n"))

    await expect(loadEnv(dir, { TELEGRAM_BOT_TOKEN: "from-env" })).resolves.toMatchObject({
      TELEGRAM_API_BASE_URL: "https://telegram.example.test",
      TELEGRAM_BOT_TOKEN: "from-env",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "secret value",
    })
  })

  it("builds the default Telegram webhook URL", () => {
    expect(createTelegramWebhookUrl("https://worker.example.test")).toBe("https://worker.example.test/api/webhooks/telegram")
  })

  it("detects pnpm bin symlinks as the CLI entrypoint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vitehub-chat-cli-"))
    const target = join(dir, "cli.js")
    const linked = join(dir, "vitehub-chat")
    await writeFile(target, "#!/usr/bin/env node\n")
    await symlink(target, linked)

    expect(isCliEntrypoint(linked, pathToFileURL(await realpath(target)).href)).toBe(true)
  })

  it("sets Telegram webhook using env tokens and route override", async () => {
    const stdout = createWriter()
    const stderr = createWriter()
    const fetchMock = vi.fn(async () => Response.json({ ok: true, result: true }))

    const exitCode = await main([
      "telegram",
      "webhook",
      "set",
      "https://worker.example.test",
      "--route",
      "/hooks/tg",
    ], {
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_WEBHOOK_SECRET_TOKEN: "secret-token",
      },
      fetch: fetchMock as never,
      stderr: stderr.stream,
      stdout: stdout.stream,
    })

    expect(exitCode).toBe(0)
    expect(stderr.output()).toBe("")
    expect(fetchMock).toHaveBeenCalledWith("https://api.telegram.org/botbot-token/setWebhook", expect.objectContaining({
      body: JSON.stringify({
        secret_token: "secret-token",
        url: "https://worker.example.test/hooks/tg",
      }),
      method: "POST",
    }))
    expect(JSON.parse(stdout.output())).toEqual({ ok: true, result: true })
  })

  it("prints webhook info from Telegram", async () => {
    const stdout = createWriter()
    const fetchMock = vi.fn(async () => Response.json({ ok: true, result: { pending_update_count: 0 } }))

    const exitCode = await main(["telegram", "webhook", "info"], {
      env: { TELEGRAM_BOT_TOKEN: "bot-token" },
      fetch: fetchMock as never,
      stdout: stdout.stream,
    })

    expect(exitCode).toBe(0)
    expect(fetchMock).toHaveBeenCalledWith("https://api.telegram.org/botbot-token/getWebhookInfo", expect.objectContaining({
      body: "{}",
      method: "POST",
    }))
    expect(JSON.parse(stdout.output())).toEqual({ ok: true, result: { pending_update_count: 0 } })
  })
})
