import { describe, expect, it, vi } from "vitest"

import { runViteHubCli } from "../src/index.ts"

async function run(args: string[]) {
  let stderr = ""
  const loadConfig = vi.fn(async () => ({ plugins: [], root: process.cwd() }))
  const exitCode = await runViteHubCli({ args, loadConfig, stderr: { write: chunk => { stderr += String(chunk) } }, stdout: { write: () => true } })
  return { exitCode, loadConfig, stderr }
}

describe("renamed commands", () => {
  it.each([
    [["agent", "info", "--agent", "support"], "vitehub agent get"],
    [["agents", "list"], "vitehub agent list"],
    [["agents", "invoke", "support"], "vitehub agent invoke"],
    [["agents", "status"], "vitehub agent get <name>"],
    [["invocations", "list"], "vitehub agent invocations list"],
    [["invocations", "workspace", "inv_1"], "vitehub agent invocations workspace"],
    [["conversations", "export", "a", "c", "t"], "vitehub agent conversations export"],
    [["agent", "invocations", "show", "inv_1"], "vitehub agent invocations get"],
    [["content", "show", "docs", "intro"], "vitehub content get"],
    [["email", "outbox", "show", "msg_1"], "vitehub email outbox get"],
    [["queue", "jobs", "show", "job_1"], "vitehub queue jobs get"],
    [["workspace", "show", "docs", "main"], "vitehub workspace get"],
    [["workflow", "get", "wrun_1"], "vitehub workflow runs get"],
    [["workflow", "runs", "show", "wrun_1"], "vitehub workflow runs get"],
    [["schedule", "runs", "nightly"], "vitehub schedule runs list <schedule>"],
    [["schedule", "attempts", "srun_1"], "vitehub schedule runs get <run>"],
    [["env", "inspect"], "vitehub env list"],
    [["env", "status", "--url", "https://app.example.com"], "vitehub env list --url <app>"],
    [["project", "info"], "vitehub project get"],
    [["definitions", "list", "kv"], "vitehub inspect definitions"],
  ])("fails for vitehub %j and names %s, before the project config loads", async (args, now) => {
    const result = await run(args)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`is now \`${now}\``)
    expect(result.loadConfig).not.toHaveBeenCalled()
  })

  it("runs the new spellings", async () => {
    for (const args of [["schedule", "runs", "list", "nightly"], ["schedule", "runs", "get", "srun_1"], ["schedule", "runs", "--help"]]) {
      expect((await run(args)).stderr).not.toContain("is now")
    }
  })
})
