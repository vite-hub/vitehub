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
