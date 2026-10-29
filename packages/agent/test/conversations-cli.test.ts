import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createAgentCliContributor } from "../src/cli.ts"
import { runConversationsExportCli } from "../src/internal/conversations-cli.ts"

const photo = Buffer.from([1, 2, 3]).toString("base64")
const exported = {
  filename: "telegram-456.md",
  format: "markdown",
  media: [{ base64: photo, mimeType: "image/jpeg", path: "media/0001-meal.jpg", size: 3 }],
  messageCount: 2,
  mimeType: "text/markdown",
  retention: { durable: false, maxMessages: 100, mode: "provider-window", transcripts: false, ttlMs: 604_800_000, warning: "Transcripts are not durable. Older messages may be missing." },
  text: "# Conversation telegram:456\n\n### Maxi · 2026-06-10 12:00 UTC\n\nhello\n",
}

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { force: true, recursive: true })
})

function run(args: string[], answer: () => Response = () => Response.json({ ok: true, value: exported })) {
  const calls: Array<{ body: unknown, url: string }> = []
  const stdout: string[] = []
  const stderr: string[] = []
  const done = mkdtemp(join(tmpdir(), "vitehub-conversations-cli-")).then(async (cwd) => {
    directories.push(cwd)
    const code = await runConversationsExportCli(args, {
      cwd,
      env: {},
      fetch: async (url, init) => {
        calls.push({ body: JSON.parse(String(init?.body)), url: String(url) })
        return answer()
      },
      rootDir: cwd,
      stderr: { write: chunk => stderr.push(String(chunk)) },
      stdout: { write: chunk => stdout.push(String(chunk)) },
    })
    return { calls, code, cwd, stderr: stderr.join(""), stdout: stdout.join("") }
  })
  return done
}

describe("vitehub conversations export", () => {
  it("prints the Markdown to stdout, so it can be redirected to a file", async () => {
    const result = await run(["support", "telegram", "telegram:456", "--url", "https://app.example.com"])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(exported.text)
    expect(result.calls).toEqual([{
      body: { input: { agent: "support", channel: "telegram", format: "markdown", media: false, thread: "telegram:456" }, operation: "conversations.export" },
      url: "https://app.example.com/_vitehub/rpc/__call",
    }])
    // The retention warning goes to stderr, so the redirected file stays clean.
    expect(result.stderr).toContain("Transcripts are not durable")
  })

  it("asks for the JSON archive and writes the files and the attachments to a directory", async () => {
    const json = { ...exported, filename: "history.json", format: "json", mimeType: "application/json", text: "{\"schemaVersion\":1}\n" }
    const result = await run(["--agent", "support", "--channel", "telegram", "--thread", "telegram:456", "--format", "json", "--output", "chat", "--url", "https://app.example.com"], () => Response.json({ ok: true, value: json }))
    expect(result.code).toBe(0)
    expect(result.calls[0]!.body).toMatchObject({ input: { format: "json", media: true } })
    expect(result.stdout).toBe(`Wrote 2 messages and 1 attachments to ${join(result.cwd, "chat")}\n`)
    await expect(readFile(join(result.cwd, "chat", "history.json"), "utf8")).resolves.toBe("{\"schemaVersion\":1}\n")
    await expect(readFile(join(result.cwd, "chat", "media", "0001-meal.jpg"))).resolves.toEqual(Buffer.from([1, 2, 3]))
    // A second export does not overwrite the first.
    const again = await runConversationsExportCli(["support", "telegram", "t", "--output", join(result.cwd, "chat"), "--url", "https://app.example.com"], {
      cwd: result.cwd,
      env: {},
      fetch: async () => Response.json({ ok: true, value: json }),
      rootDir: result.cwd,
      stderr: { write: () => true },
      stdout: { write: () => true },
    })
    expect(again).toBe(1)
  })

  it("refuses a file name or a media path that leaves the output directory, and writes nothing", async () => {
    for (const bad of [{ filename: "../escape.md" }, { filename: "/tmp/absolute.md" }, { media: [{ base64: photo, path: "media/../../escape.png" }] }, { media: [{ base64: photo, path: "../escape.png" }] }, { filename: "" }]) {
      const result = await run(["support", "telegram", "t", "--output", "out", "--url", "https://app.example.com"], () => Response.json({ ok: true, value: { ...exported, ...bad } }))
      expect(result.code, JSON.stringify(bad)).toBe(1)
      expect(result.stderr).toContain("outside the output directory")
      await expect(readFile(join(result.cwd, "out", "telegram-456.md"))).rejects.toThrow()
      await expect(readFile(join(result.cwd, "..", "escape.md"))).rejects.toThrow()
      await expect(readdir(result.cwd)).resolves.toEqual([])
    }
  })

  it("reports a coded failure with its fix, and refuses attachments without a directory", async () => {
    const failed = await run(["support", "telegram", "t", "--url", "https://app.example.com"], () => Response.json({ code: "CHANNELS_NOT_FOUND", fix: "Run `vitehub channels list`.", message: "No such Channel.", ok: false, status: 404 }, { status: 404 }))
    expect(failed.code).toBe(1)
    expect(failed.stderr).toBe("CHANNELS_NOT_FOUND: No such Channel.\nFix: Run `vitehub channels list`.\n")
    const usage = await run(["support", "telegram", "t", "--media", "--url", "https://app.example.com"])
    expect(usage.code).toBe(1)
    expect(usage.stderr).toContain("--media needs --output")
    expect(usage.calls).toEqual([])
    const missing = await run(["support"])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain("An agent, a channel, and a thread are required.")
  })

  it("is a command of the agent CLI, next to channels history", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-conversations-root-"))
    directories.push(rootDir)
    const contributor = await createAgentCliContributor({ rootDir, serverDirs: [] })
    const features = (name: string) => contributor!.namespaces.find(namespace => namespace.name === name)?.features.map(feature => feature.name)
    expect(features("conversations")).toEqual(["export"])
    expect(features("channels")).toEqual(expect.arrayContaining(["export", "history", "replay", "sync"]))
  })
})
