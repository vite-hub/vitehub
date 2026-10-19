import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { runAgentCodexHomeCli } from "../src/internal/agent-codex-home-cli.ts"

const day = 86_400_000
let root: string
let home: string

function output() {
  let text = ""
  return { stream: { write: (chunk: string | Uint8Array) => { text += String(chunk) } }, text: () => text }
}

async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const stdout = output()
  const stderr = output()
  const code = await runAgentCodexHomeCli(args, { env, stderr: stderr.stream, stdout: stdout.stream })
  return { code, stderr: stderr.text(), stdout: stdout.text() }
}

async function rollout(id: string, ageMs: number): Promise<string> {
  const created = new Date(Date.now() - ageMs)
  const iso = created.toISOString()
  const path = join(home, "sessions", iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10), `rollout-${iso.slice(0, 19).replaceAll(":", "-")}-${id}.jsonl`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ payload: { id }, type: "session_meta" })}\n${"x".repeat(2000)}`)
  await utimes(path, created, created)
  return path
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vitehub-codex-home-cli-"))
  home = join(root, "codex")
  await mkdir(home)
  const logs = new DatabaseSync(join(home, "logs_2.sqlite"))
  logs.exec("PRAGMA auto_vacuum = 2; CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, estimated_bytes INTEGER NOT NULL DEFAULT 0);")
  logs.prepare("INSERT INTO logs (ts, estimated_bytes) VALUES (?, 10)").run(Math.floor((Date.now() - 30 * day) / 1000))
  logs.close()
})

afterEach(async () => {
  await rm(root, { force: true, recursive: true })
})

describe("vitehub agent codex-home", () => {
  it("measures a Codex home with status", async () => {
    await rollout("01a15300-0000-7000-8000-000000000001", 30 * day)
    await rollout("01a15300-0000-7000-8000-000000000002", day)

    const text = await run(["status", "--home", home])
    expect(text.code).toBe(0)
    expect(text.stdout).toContain(`Codex home ${home}`)
    expect(text.stdout).toContain("Sessions: 2")
    expect(text.stdout).toContain("logs_2.sqlite:")

    const json = await run(["status", "--json", "--max-age", "14d"], { CODEX_HOME: home })
    const status = JSON.parse(json.stdout)
    expect(status).toMatchObject({ home, records: 2, sessions: { count: 2 } })
    expect(status.databases).toEqual([expect.objectContaining({ name: "logs_2.sqlite" })])
    expect(status.prune).toMatchObject({ dryRun: true, removed: { logRows: 1, sessions: 1 } })
  })

  it("prints what prune would remove with --dry-run --json and changes nothing", async () => {
    const old = await rollout("01a15300-0000-7000-8000-000000000001", 30 * day)
    await rollout("01a15300-0000-7000-8000-000000000002", day)

    const result = await run(["prune", "--home", home, "--max-records", "1", "--max-size=45%", "--dry-run", "--json"])

    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report).toMatchObject({ dryRun: true, home, policy: { maxAge: false, maxRecords: 1, maxSize: "45%" }, removed: { sessions: 1 } })
    expect(report.budgetBytes).toBeGreaterThan(0)
    expect(await stat(old).then(() => true)).toBe(true)
  })

  it("prunes, and rejects prune without a limit", async () => {
    const old = await rollout("01a15300-0000-7000-8000-000000000001", 30 * day)

    const rejected = await run(["prune", "--home", home])
    expect(rejected.code).toBe(1)
    expect(rejected.stderr).toContain("prune requires --max-age, --max-records, or --max-size.")

    const result = await run(["prune", "--home", home, "--max-age", "14d"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Removed 1 session, 1 log row, 0 shell snapshots, and 0 temporary entries.")
    expect(await stat(old).then(() => true, () => false)).toBe(false)
  })
})
