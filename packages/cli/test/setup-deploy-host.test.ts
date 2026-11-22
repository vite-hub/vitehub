import { readFile } from "node:fs/promises"
import { join } from "node:path"
import process from "node:process"

import { describe, expect, it } from "vitest"

import { createDeployRun, hostCli } from "../src/setup/deploy/host.ts"
import { createProject } from "./setup-helpers.ts"

describe("Windows deploy CLI resolution", () => {
  it.each([
    ["wrangler", "%dp0%", "wrangler/bin/wrangler.js"],
    ["vercel", "%~dp0", "vercel/dist/index.js"],
    ["netlify", "%~dp0", "netlify-cli/bin/run"],
  ])("runs the local %s Node entrypoint with literal arguments", async (name, prefix, relative) => {
    const entry = `node_modules/${relative}`
    const root = await createProject({
      [entry]: '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n',
      [`node_modules/.bin/${name}`]: "#!/bin/sh\nexit 1\n",
      [`node_modules/.bin/${name}.cmd`]: `@ECHO off\n@"node" "${prefix}\\..\\${relative!.replaceAll("/", "\\")}" %*\n`,
    })
    const command = hostCli(name!, name!, root, { PATH: "" }, "win32")
    expect(command).toEqual([process.execPath, join(root, entry)])
    const args = ["deploy", "a project & echo injected", "$(whoami)", 'quoted " name', "100%literal!"]
    const result = await createDeployRun({ write() {} }, [])(command[0], [...command.slice(1), ...args], { cwd: root, env: {} })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(args)
  })

  it("resolves PATH shims and the npx fallback without launching batch files", async () => {
    const root = await createProject({
      "bin/wrangler.cmd": '@"node" "%dp0%\\node_modules\\wrangler\\bin\\wrangler.js" %*\n',
      "bin/node_modules/wrangler/bin/wrangler.js": "console.log('wrangler')\n",
      "bin/npx.cmd": '@"node" "%dp0%\\node_modules\\npm\\bin\\npx-cli.js" %*\n',
      "bin/node_modules/npm/bin/npx-cli.js": "console.log(JSON.stringify(process.argv.slice(2)))\n",
    })
    const env = { PATH: `${join(root, "missing")};${join(root, "bin")}` }
    expect(hostCli("wrangler", "wrangler", root, env, "win32")).toEqual([process.execPath, join(root, "bin/node_modules/wrangler/bin/wrangler.js")])
    const command = hostCli("netlify", "netlify-cli", root, env, "win32")
    expect(command).toEqual([process.execPath, join(root, "bin/node_modules/npm/bin/npx-cli.js"), "--yes", "netlify-cli"])
    const result = await createDeployRun({ write() {} }, [])(command[0], [...command.slice(1), "deploy", "literal & argument"], { cwd: root, env })
    expect(JSON.parse(result.stdout)).toEqual(["--yes", "netlify-cli", "deploy", "literal & argument"])
  })

  it("resolves native host executables", async () => {
    const root = await createProject({ "bin/deno.exe": "" })
    expect(hostCli("deno", "deno", root, { PATH: join(root, "bin") }, "win32")).toEqual([join(root, "bin/deno.exe")])
  })
})

it("redacts captured and streamed credentials across chunks and streams", async () => {
  const token = "private-host-token"
  const root = await createProject()
  let shown = ""
  const result = await createDeployRun({ write: chunk => { shown += chunk } }, [token])(process.execPath, ["-e", `
    process.stdout.write("private-")
    setTimeout(() => process.stderr.write("other stream\\n"), 10)
    setTimeout(() => {
      process.stdout.write("host-token\\n")
      process.stderr.write("private-host-token")
      process.exitCode = 1
    }, 30)
  `], { cwd: root, env: {}, show: true })
  expect(result.exitCode).toBe(1)
  expect(result.stdout).toBe("<redacted>\n")
  expect(result.stderr).toBe("other stream\n<redacted>")
  expect(shown).not.toContain(token)
  expect(shown).not.toContain("private-")
})

it("redacts a multiline value that arrives in chunks split at its newline", async () => {
  const secret = "first-line-canary\nsecond-line-canary"
  const root = await createProject()
  let shown = ""
  const result = await createDeployRun({ write: chunk => { shown += chunk } }, [secret])(process.execPath, ["-e", `
    process.stderr.write("value: first-line-canary\\n")
    setTimeout(() => process.stderr.write("second-line-canary\\ndone\\n"), 30)
  `], { cwd: root, env: {}, show: true })
  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe("value: <redacted>\ndone\n")
  expect(shown).toBe(result.stderr)
})

it.skipIf(process.platform === "win32")("lets file-reading CLIs reopen stdin without a reachable secret file", async () => {
  const root = await createProject({
    "reader.cjs": `const fs = require("node:fs")
      if (!fs.fstatSync(0).isFile()) throw new Error("stdin must be a regular file")
      if (process.platform === "linux" && !fs.readlinkSync("/proc/self/fd/0").endsWith(" (deleted)")) throw new Error("stdin file must be unlinked")
      process.stdout.write(fs.readFileSync("/dev/stdin", "utf8"))`,
  })
  const result = await createDeployRun({ write() {} }, [])(process.execPath, [join(root, "reader.cjs")], {
    cwd: root, env: {}, stdin: "transport-proof", stdinAsFile: true,
  })
  expect(result.exitCode, result.stderr).toBe(0)
  expect(result.stdout).toBe("transport-proof")
})

it.each([false, true])("keeps a shorter secret pending when it can become a longer secret (reverse: %s)", async (reverse) => {
  const root = await createProject()
  let shown = ""
  const secrets = ["shared-prefix-private-suffix", "shared-prefix"]
  if (reverse) secrets.reverse()
  const result = await createDeployRun({ write: chunk => { shown += chunk } }, secrets)(process.execPath, ["-e", `
    process.stdout.write("shared-prefix")
    setTimeout(() => process.stdout.write("-private-suffix\\n"), 50)
  `], { cwd: root, env: {}, show: true })
  expect(shown).toBe("<redacted>\n")
  expect(result.stdout).toBe(shown)
})

it.skipIf(process.platform === "win32")("aborts an execution tree even when a descendant ignores SIGTERM", async () => {
  const root = await createProject()
  const controller = new AbortController()
  let pid = 0
  const run = createDeployRun({ write(chunk) {
    pid = Number(chunk.trim())
    controller.abort()
  } }, [])
  const result = run(process.execPath, ["-e", `
    require("node:child_process").spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); console.log(process.pid); setInterval(() => {}, 1000);'], { stdio: ["ignore", "inherit", "inherit"] });
    setInterval(() => {}, 1000);
  `], { cwd: root, env: {}, show: true, signal: controller.signal })
  try {
    await expect(result).rejects.toMatchObject({ name: "AbortError" })
    expect(pid).toBeGreaterThan(0)
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")
      expect(stat === "" || stat.includes(") Z ")).toBe(true)
    }
    else {
      expect(() => process.kill(pid, 0)).toThrow()
    }
  }
  finally {
    if (pid) { try { process.kill(pid, "SIGKILL") } catch {} }
  }
}, 5000)
