import { spawn } from "node:child_process"
import { once } from "node:events"
import { pathToFileURL } from "node:url"

import { describe, expect, it, vi } from "vitest"

import { runTypecheck, typecheckEnvironment } from "./typecheck.mjs"

describe("root typecheck task environment", () => {
  it("provides a default heap size when NODE_OPTIONS is absent", () => {
    expect(typecheckEnvironment({ PATH: "/bin" })).toMatchObject({
      NODE_OPTIONS: "--max-old-space-size=4096",
      PATH: "/bin",
    })
  })

  it("preserves caller-provided NODE_OPTIONS", () => {
    expect(typecheckEnvironment({ NODE_OPTIONS: "--trace-warnings" })).toEqual({ NODE_OPTIONS: "--trace-warnings" })
  })

  it("runs each phase through Node and stops after a failure", async () => {
    const execute = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(7)

    expect(await runTypecheck({}, execute)).toBe(7)
    expect(execute).toHaveBeenCalledTimes(2)
    const [command, buildArgs, environment] = execute.mock.calls[0]!
    expect(command).toBe(process.execPath)
    expect(buildArgs.slice(1)).toEqual(["run", "build"])
    expect(environment.NODE_OPTIONS).toBe("--max-old-space-size=4096")
    expect(execute.mock.calls[1]![1].slice(1)).toEqual([
      "run", "--filter", "vitehub-docs", "--ignore-depends-on", "typecheck",
    ])
  })

  it.skipIf(process.platform === "win32").each(["SIGINT", "SIGTERM"] as const)("cleans up the active process group on %s", async (signal) => {
    const moduleUrl = pathToFileURL(`${import.meta.dirname}/typecheck.mjs`).href
    const descendant = `process.on('${signal}', () => process.exit(0)); console.log('ready'); setInterval(() => {}, 1000)`
    const phase = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'pipe', 'inherit'] });
      process.on('${signal}', () => {});
      child.stdout.once('data', () => console.log('ready', process.pid));
      child.once('exit', () => process.exit(0));
    `
    const script = `
      import { runTypecheck, runTypecheckPhase } from ${JSON.stringify(moduleUrl)};
      let calls = 0;
      process.exitCode = await runTypecheck(process.env, (_, __, env, abortSignal) => {
        if (++calls > 1) throw new Error('Started a phase after interruption');
        return runTypecheckPhase(process.execPath, ['-e', ${JSON.stringify(phase)}], env, abortSignal);
      });
    `
    const wrapper = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] })
    const timeout = AbortSignal.timeout(5000)
    const closed = once(wrapper, "close", { signal: timeout })
    let phasePid: number | undefined
    try {
      const [ready] = await once(wrapper.stdout, "data", { signal: timeout })
      phasePid = Number(String(ready).trim().split(" ")[1])
      expect(phasePid).toBeGreaterThan(0)
      wrapper.kill(signal)
      expect((await closed)[0]).toBe(signal === "SIGINT" ? 130 : 143)
      expect(() => process.kill(phasePid!, 0)).toThrow()
    }
    finally {
      wrapper.kill("SIGKILL")
      if (phasePid) {
        try { process.kill(-phasePid, "SIGKILL") }
        catch { /* The process group has already exited. */ }
      }
      await closed.catch(() => {})
    }
  })
})
