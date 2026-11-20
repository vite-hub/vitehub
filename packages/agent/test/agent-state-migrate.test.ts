import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { runAgentStateCli } from "../src/internal/agent-state-cli.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"

import type { QueueEntry } from "chat"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function stateFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vitehub-agent-state-migrate-"))
  tempDirs.push(dir)
  return `file:${join(dir, "chat_state.sqlite.db")}`
}

function queueEntry(text: string): QueueEntry {
  return {
    enqueuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
    message: {
      author: { fullName: "User", isBot: false, isMe: false, userId: "u", userName: "user" },
      formatted: { children: [], type: "root" },
      id: text,
      text,
    } as unknown as QueueEntry["message"],
  }
}

async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  let stdout = ""
  let stderr = ""
  const code = await runAgentStateCli(args, {
    env,
    stderr: { write: (chunk) => { stderr += String(chunk) } },
    stdout: { write: (chunk) => { stdout += String(chunk) } },
  })
  return { code, stderr, stdout }
}

/** Writes keys as the Chat SDK does through an explicit, unscoped `messages.state`. */
async function seedUnscopedState(url: string) {
  const state = createLibsqlAgentState({ url })
  await state.connect()
  await state.set("thread-state:teams:conv-1", { title: "Old thread" })
  await state.set("channel-state:productlane:card-1", { open: true })
  await state.set("chat:callback:token-1", { url: "https://example.com" })
  await state.set("thread-state:slack:C1", { title: "Other adapter" })
  // ViteHub already wrote its own keys under the Channel scope.
  await state.set("chat:bot:teams:interrupted", { ok: true })
  await state.set("webhook:bot:teams:teams:cursor", 1)
  await state.appendToList("msg-history:teams:conv-1", { text: "one" })
  await state.appendToList("msg-history:teams:conv-1", { text: "two" })
  await state.appendToList("transcripts:user:teams:u1", { text: "hi" })
  await state.subscribe("teams:conv-1")
  await state.enqueue("teams:conv-1", queueEntry("queued"), 10)
  await state.acquireLock("teams:conv-2", 60_000)
  await state.disconnect()
}

describe("vitehub agent state migrate", () => {
  it("prints the moves without --apply and moves the keys to their Channel scope with it", async () => {
    const url = await stateFile()
    await seedUnscopedState(url)
    const args = ["migrate", "--agent", "bot", "--channel", "teams", "--channel", "productlane=support"]

    const dryRun = await run(args, { VITEHUB_AGENT_STATE_URL: url })
    expect(dryRun).toMatchObject({ code: 0, stderr: "" })
    expect(dryRun.stdout).toContain("6 keys move to their Channel scope.")
    expect(dryRun.stdout).toContain("thread-state:teams:conv-1 -> chat:bot:teams:thread-state:teams:conv-1")
    expect(dryRun.stdout).toContain("channel-state:productlane:card-1 -> chat:bot:support:channel-state:productlane:card-1")
    expect(dryRun.stdout).toContain("transcripts:user:teams:u1 -> chat:bot:transcripts:user:teams:u1")
    expect(dryRun.stdout).toContain("2 keys name no listed adapter and stay:\n  chat:callback:token-1\n  thread-state:slack:C1")
    expect(dryRun.stdout).toContain("1 lock stays.")
    expect(dryRun.stdout).toContain("Dry run: nothing changed.")

    const state = createLibsqlAgentState({ url })
    await state.connect()
    await expect(state.get("thread-state:teams:conv-1")).resolves.toEqual({ title: "Old thread" })
    await expect(state.get("chat:bot:teams:thread-state:teams:conv-1")).resolves.toBeNull()
    await state.disconnect()

    const applied = await run([...args, "--url", url, "--apply"])
    expect(applied).toMatchObject({ code: 0, stderr: "" })
    expect(applied.stdout).toContain("Moved 6 keys to their Channel scope.")

    await state.connect()
    await expect(state.get("chat:bot:teams:thread-state:teams:conv-1")).resolves.toEqual({ title: "Old thread" })
    await expect(state.get("thread-state:teams:conv-1")).resolves.toBeNull()
    await expect(state.get("chat:bot:support:channel-state:productlane:card-1")).resolves.toEqual({ open: true })
    await expect(state.getList("chat:bot:teams:msg-history:teams:conv-1")).resolves.toEqual([{ text: "one" }, { text: "two" }])
    await expect(state.getList("chat:bot:transcripts:user:teams:u1")).resolves.toEqual([{ text: "hi" }])
    await expect(state.isSubscribed("chat:bot:teams:teams:conv-1")).resolves.toBe(true)
    await expect(state.isSubscribed("teams:conv-1")).resolves.toBe(false)
    await expect(state.queueDepth("chat:bot:teams:teams:conv-1")).resolves.toBe(1)
    await expect(state.queueDepth("teams:conv-1")).resolves.toBe(0)
    // Keys of other adapters and keys that ViteHub scoped itself stay.
    await expect(state.get("thread-state:slack:C1")).resolves.toEqual({ title: "Other adapter" })
    await expect(state.get("chat:bot:teams:interrupted")).resolves.toEqual({ ok: true })
    await expect(state.get("webhook:bot:teams:teams:cursor")).resolves.toBe(1)
    await state.disconnect()

    const again = await run([...args, "--url", url, "--apply"])
    expect(again.stdout).toContain("Moved 0 keys to their Channel scope.")
  })

  it("keeps a key whose Channel scope already has a value", async () => {
    const url = await stateFile()
    const state = createLibsqlAgentState({ url })
    await state.connect()
    await state.set("thread-state:teams:conv-1", { title: "Old" })
    await state.set("chat:bot:teams:thread-state:teams:conv-1", { title: "New" })
    await state.disconnect()

    const applied = await run(["migrate", "--agent=bot", "--channel=teams", `--url=${url}`, "--apply"])
    expect(applied.stdout).toContain("Moved 0 keys to their Channel scope.\n1 key already exists in the Channel scope and stays.")

    await state.connect()
    await expect(state.get("chat:bot:teams:thread-state:teams:conv-1")).resolves.toEqual({ title: "New" })
    await expect(state.get("thread-state:teams:conv-1")).resolves.toEqual({ title: "Old" })
    await state.disconnect()
  })

  it("rejects missing arguments and a State file that does not exist", async () => {
    const missingChannel = await run(["migrate", "--agent", "bot", "--url", "file:/tmp/state.db"])
    expect(missingChannel.code).toBe(1)
    expect(missingChannel.stderr).toContain("AGENT_STATE_MIGRATE_ARGUMENT_INVALID")
    expect(missingChannel.stderr).toContain("Pass --channel")

    const missingUrl = await run(["migrate", "--agent", "bot", "--channel", "teams"])
    expect(missingUrl.stderr).toContain("VITEHUB_AGENT_STATE_URL")

    const dir = await mkdtemp(join(tmpdir(), "vitehub-agent-state-migrate-"))
    tempDirs.push(dir)
    const missingFile = await run(["migrate", "--agent", "bot", "--channel", "teams", "--url", join(dir, "missing.db")])
    expect(missingFile.code).toBe(1)
    expect(missingFile.stderr).toContain("AGENT_STATE_MIGRATE_DATABASE_MISSING")

    await expect(run([])).resolves.toMatchObject({ code: 0 })
  })
})
