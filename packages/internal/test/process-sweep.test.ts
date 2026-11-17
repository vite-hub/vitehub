import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

import { stopMarkedProcesses } from "../src/process-sweep.ts"

// A killed orphan can stay a zombie until its new parent reaps it.
const running = (pid: number) => readFile(`/proc/${pid}/stat`, "utf8").then(stat => !/\) Z /.test(stat), () => false)

// The sleep runs in its own session, outside the process group of the shell that started it.
async function startDetachedSleep(env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn("sh", ["-c", "setsid sh -c 'echo $$; exec sleep 600 >/dev/null' &"], { env, stdio: ["ignore", "pipe", "ignore"] })
  let output = ""
  for await (const chunk of child.stdout) output += chunk
  const pid = Number(output.trim())
  expect(pid).toBeGreaterThan(0)
  return pid
}

describe.skipIf(process.platform !== "linux")("stopMarkedProcesses", () => {
  it("stops a process that left its process group and keeps unmarked processes", async () => {
    const marker = randomUUID()
    const marked = await startDetachedSleep({ ...process.env, VITEHUB_TEST_PASS: marker })
    const other = await startDetachedSleep({ ...process.env, VITEHUB_TEST_PASS: `${marker}-other` })
    try {
      expect(await running(marked)).toBe(true)
      await stopMarkedProcesses("VITEHUB_TEST_PASS", marker)
      await expect.poll(() => running(marked)).toBe(false)
      expect(await running(other)).toBe(true)
    }
    finally {
      for (const pid of [marked, other]) {
        try {
          process.kill(pid, "SIGKILL")
        }
        catch {}
      }
    }
  })
})
