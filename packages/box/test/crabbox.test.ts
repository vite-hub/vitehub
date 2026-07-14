import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { HarnessV1SandboxProvider } from "@ai-sdk/harness"
import { afterEach, describe, expect, it } from "vitest"

import { resolveBox } from "../src/index.ts"
import { crabbox } from "../src/crabbox.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("crabbox", () => {
  it("resolves a provider-neutral Box without serializing its runtime bridge", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    await mkdir(workspace)

    const box = await resolveBox({
      runtime: crabbox({ profile: "babysitter" }),
      requires: ["github", "pnpm"],
      cwd: ({ worktree }: { worktree: string }) => worktree,
    }, { worktree: workspace }, { requires: ["codex", "github"] })

    expect(box).toMatchObject({
      cache: { state: "disposable" },
      environment: {},
      isolation: "none",
      runtime: "crabbox",
      requirements: [
        { command: "gh", name: "github" },
        { command: "pnpm", name: "pnpm" },
        { command: "codex", name: "codex" },
      ],
      workspace: { path: workspace, state: "authoritative" },
    })
    expect(box.sandbox).toMatchObject({ providerId: "crabbox" })
    expect(JSON.stringify(box)).not.toContain("sandbox")
  })

  it("rejects invalid Box requirement names", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    await mkdir(workspace)

    await expect(resolveBox({
      runtime: crabbox(),
      requires: [""],
      cwd: workspace,
    }, {})).rejects.toThrow("Box requirements must be non-empty names")
    await expect(resolveBox({
      runtime: crabbox(),
      requires: [null as never],
      cwd: workspace,
    }, {})).rejects.toThrow("Box requirements must be non-empty names")
  })

  it("boots through Crabbox, validates requirements there, and preserves workspace mutations", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    const bin = join(root, "bin")
    const log = join(root, "crabbox.log")
    await Promise.all([mkdir(workspace), mkdir(bin)])
    await fakeCrabbox(bin)
    await Promise.all([
      executable(bin, "codex", "exit 0"),
      executable(bin, "gh", "exit 0"),
      executable(bin, "pnpm", "exit 0"),
    ])

    await withEnvironment({ CRABBOX_TEST_LOG: log, PATH: `${bin}:${process.env.PATH || ""}` }, async () => {
      const box = await resolveBox({
        runtime: crabbox({ network: "direct", profile: "babysitter", reclaim: true }),
        requires: ["github", "pnpm"],
        cwd: workspace,
      }, {}, { requires: ["codex"] })
      const sandbox = box.sandbox as { createSession(): Promise<any> }
      const session = await sandbox.createSession()
      const cacheRoot = session.defaultWorkingDirectory

      await session.writeTextFile({ content: "cache", path: "cache.txt" })
      await expect(session.readTextFile({ path: "cache.txt" })).resolves.toBe("cache")
      await expect(session.run({
        command: "printf changed > changed.txt",
        workingDirectory: join(cacheRoot, "workspace"),
      })).resolves.toMatchObject({ exitCode: 0 })
      await expect(readFile(join(workspace, "changed.txt"), "utf8")).resolves.toBe("changed")
      await expect(session.getPortUrl({ port: 3000, protocol: "ws" })).resolves.toBe("ws://127.0.0.1:3000")

      await session.destroy()
      await expect(readFile(join(cacheRoot, "cache.txt"))).rejects.toMatchObject({ code: "ENOENT" })
      await expect(readdir(workspace)).resolves.toEqual(["changed.txt"])

      const workRoot = join(root, ".crabbox")
      const workRootCwd = await realpath(workRoot)
      const invocations = (await readFile(log, "utf8")).trim().split("\n")
      expect(invocations).not.toContain(expect.stringContaining("|tunnel|"))
      expect(invocations.filter(invocation => invocation.includes("|warmup|")).every(invocation => invocation.startsWith(`${workRootCwd}|`))).toBe(true)
      expect(invocations.every(invocation => invocation.includes(`--static-work-root ${workRoot}`))).toBe(true)
      expect(invocations.find(invocation => invocation.includes("|warmup|"))).toContain(`--static-work-root ${workRoot} --reclaim`)
    })
  }, 30_000)

  it("tunnels ports by default", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    const bin = join(root, "bin")
    const log = join(root, "crabbox.log")
    await Promise.all([mkdir(workspace), mkdir(bin)])
    await fakeCrabbox(bin)

    await withEnvironment({ CRABBOX_TEST_LOG: log, PATH: `${bin}:${process.env.PATH || ""}` }, async () => {
      const box = await resolveBox({ runtime: crabbox({ profile: "babysitter" }), cwd: workspace }, {})
      const sandbox = box.sandbox as { createSession(): Promise<any> }
      const session = await sandbox.createSession()

      await expect(session.getPortUrl({ port: 3000, protocol: "ws" })).resolves.toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
      await session.destroy()

      const workRoot = join(root, ".crabbox")
      await expect(readFile(log, "utf8")).resolves.toContain(`|tunnel|--provider ssh --id static_test --static-work-root ${workRoot}`)
    })
  }, 30_000)

  it("reuses one pending tunnel for concurrent port URL requests", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    const bin = join(root, "bin")
    const log = join(root, "crabbox.log")
    await Promise.all([mkdir(workspace), mkdir(bin)])
    await fakeCrabbox(bin)

    await withEnvironment({ CRABBOX_TEST_LOG: log, PATH: `${bin}:${process.env.PATH || ""}` }, async () => {
      const box = await resolveBox({ runtime: crabbox({ profile: "babysitter" }), cwd: workspace }, {})
      const sandbox = box.sandbox as { createSession(): Promise<any> }
      const session = await sandbox.createSession()

      const urls = await Promise.all([
        session.getPortUrl({ port: 3000 }),
        session.getPortUrl({ port: 3000 }),
      ])
      expect(urls[0]).toBe(urls[1])
      await session.destroy()

      const invocations = (await readFile(log, "utf8")).trim().split("\n")
      expect(invocations.filter(invocation => invocation.includes("|tunnel|"))).toHaveLength(1)
    })
  }, 30_000)

  it("stops a tunnel that is still waiting for readiness", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    const bin = join(root, "bin")
    const tunnelPid = join(root, "tunnel.pid")
    await Promise.all([mkdir(workspace), mkdir(bin)])
    await fakeCrabbox(bin)

    await withEnvironment({
      CRABBOX_TEST_TUNNEL_DELAY: "1",
      CRABBOX_TEST_TUNNEL_PID: tunnelPid,
      PATH: `${bin}:${process.env.PATH || ""}`,
    }, async () => {
      const box = await resolveBox({ runtime: crabbox({ profile: "babysitter" }), cwd: workspace }, {})
      const sandbox = box.sandbox as { createSession(): Promise<any> }
      const session = await sandbox.createSession()
      const url = session.getPortUrl({ port: 3000 })
      url.catch(() => undefined)

      await waitForFile(tunnelPid)
      const pid = Number(await readFile(tunnelPid, "utf8"))
      await session.destroy()
      await expect(url).rejects.toThrow("Crabbox tunnel exited before readiness")
      expect(isAlive(pid)).toBe(false)
    })
  }, 30_000)

  it("shares one static lease root across concurrent sibling workspaces", async () => {
    const root = await temporaryRoot()
    const workspaces = [join(root, "pr-1"), join(root, "pr-2")]
    const bin = join(root, "bin")
    const claim = join(root, "claim")
    const log = join(root, "crabbox.log")
    await Promise.all([...workspaces.map(workspace => mkdir(workspace)), mkdir(bin)])
    await fakeCrabbox(bin)

    await withEnvironment({
      CRABBOX_TEST_CLAIM: claim,
      CRABBOX_TEST_LOG: log,
      PATH: `${bin}:${process.env.PATH || ""}`,
    }, async () => {
      const sessions = await Promise.all(workspaces.map(async (workspace) => {
        const box = await resolveBox({
          runtime: crabbox({ profile: "babysitter", reclaim: true }),
          cwd: workspace,
        }, {})
        return await (box.sandbox as { createSession(): Promise<any> }).createSession()
      }))

      await Promise.all(sessions.map(session => session.destroy()))

      const workRoot = join(root, ".crabbox")
      const workRootCwd = await realpath(workRoot)
      const invocations = (await readFile(log, "utf8")).trim().split("\n")
      const warmups = invocations.filter(invocation => invocation.includes("|warmup|"))
      expect(warmups).toHaveLength(2)
      expect(warmups.every(invocation => invocation.startsWith(`${workRootCwd}|`))).toBe(true)
      expect(invocations.every(invocation => invocation.includes(`--static-work-root ${workRoot}`))).toBe(true)
      expect(warmups.every(invocation => invocation.endsWith("--reclaim --timing-json"))).toBe(true)
    })
  }, 30_000)

  it("isolates Crabbox state across concurrent session bootstrap", async () => {
    const root = await temporaryRoot()
    const workspaces = [join(root, "pr-1"), join(root, "pr-2")]
    const bin = join(root, "bin")
    const inheritedState = join(root, "inherited-state")
    const race = join(root, "copy-race")
    const stateLog = join(root, "state.log")
    await Promise.all([...workspaces.map(workspace => mkdir(workspace)), mkdir(bin), mkdir(inheritedState)])
    await fakeCrabbox(bin)

    await withEnvironment({
      CRABBOX_TEST_STATE_LOG: stateLog,
      CRABBOX_TEST_STATE_RACE: race,
      PATH: `${bin}:${process.env.PATH || ""}`,
      XDG_STATE_HOME: inheritedState,
    }, async () => {
      const sessions = await Promise.all(workspaces.map(async (workspace, index) => {
        const box = await resolveBox({
          runtime: crabbox({ profile: "babysitter", reclaim: true }),
          cwd: workspace,
        }, {})
        return await (box.sandbox as HarnessV1SandboxProvider).createSession({
          async onFirstCreate(session) {
            await session.writeTextFile({ content: `bootstrap-${index}`, path: "bootstrap.txt" })
          },
        })
      }))

      const stateHomes = [...new Set((await readFile(stateLog, "utf8")).trim().split("\n"))]
      expect(stateHomes).toHaveLength(2)
      expect(stateHomes).not.toContain(inheritedState)
      await expect(Promise.all(stateHomes.map(stateHome => stat(stateHome)))).resolves.toHaveLength(2)

      await Promise.all(sessions.map(session => session.destroy?.()))
      for (const stateHome of stateHomes) {
        await expect(stat(stateHome)).rejects.toMatchObject({ code: "ENOENT" })
      }
    })
  }, 30_000)

  it("stops boot when named authentication is not ready", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    const bin = join(root, "bin")
    const stateLog = join(root, "state.log")
    await Promise.all([mkdir(workspace), mkdir(bin)])
    await fakeCrabbox(bin)
    await executable(bin, "gh", 'echo "not logged in" >&2\nexit 1')

    await withEnvironment({ CRABBOX_TEST_STATE_LOG: stateLog, PATH: `${bin}:${process.env.PATH || ""}` }, async () => {
      const box = await resolveBox({
        runtime: crabbox({ profile: "babysitter" }),
        requires: ["github"],
        cwd: workspace,
      }, {})
      const sandbox = box.sandbox as { createSession(): Promise<unknown> }
      await expect(sandbox.createSession()).rejects.toThrow('Box requirement "github" failed: not logged in')
      const [stateHome] = [...new Set((await readFile(stateLog, "utf8")).trim().split("\n"))]
      await expect(stat(stateHome)).rejects.toMatchObject({ code: "ENOENT" })
    })
  }, 30_000)
})

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-box-test-"))
  roots.push(root)
  return root
}

async function fakeCrabbox(bin: string) {
  const command = join(bin, "crabbox")
  await writeFile(command, `#!/bin/sh
verb="$1"
shift
if [ -n "$CRABBOX_TEST_LOG" ]; then printf '%s|%s|%s\n' "$PWD" "$verb" "$*" >> "$CRABBOX_TEST_LOG"; fi
if [ -n "$CRABBOX_TEST_STATE_LOG" ]; then printf '%s\n' "$XDG_STATE_HOME" >> "$CRABBOX_TEST_STATE_LOG"; fi
case "$verb" in
  warmup)
    test "$CRABBOX_PROFILE" = babysitter || exit 20
    if [ -n "$CRABBOX_TEST_CLAIM" ]; then
      work_root=
      previous=
      for value in "$@"; do
        if [ "$previous" = --static-work-root ]; then work_root="$value"; break; fi
        previous="$value"
      done
      while ! mkdir "$CRABBOX_TEST_CLAIM.lock" 2>/dev/null; do sleep 0.01; done
      trap 'rmdir "$CRABBOX_TEST_CLAIM.lock"' EXIT
      if [ -f "$CRABBOX_TEST_CLAIM" ] && [ "$(cat "$CRABBOX_TEST_CLAIM")" != "$work_root" ]; then
        printf '%s\n' 'lease claim changed; retry' >&2
        exit 22
      fi
      printf '%s\n' "$work_root" > "$CRABBOX_TEST_CLAIM"
    fi
    printf '%s\n' '{"provider":"ssh","leaseId":"static_test","exitCode":0}' >&2
    ;;
  run)
    script=
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --shell ]; then shift; script="$1"; break; fi
      if [ "$1" = --script-stdin ]; then exec /bin/sh; fi
      shift
    done
    /bin/sh -c "$script"
    ;;
  cp)
    if [ -n "$CRABBOX_TEST_STATE_RACE" ]; then
      mkdir -p "$CRABBOX_TEST_STATE_RACE" "$XDG_STATE_HOME"
      touch "$CRABBOX_TEST_STATE_RACE/$$"
      attempts=0
      while [ "$(find "$CRABBOX_TEST_STATE_RACE" -type f | wc -l | tr -d ' ')" -lt 2 ]; do
        attempts=$((attempts + 1))
        test "$attempts" -lt 500 || exit 22
        sleep 0.01
      done
      if ! mkdir "$XDG_STATE_HOME/copy.lock" 2>/dev/null; then
        printf '%s\n' 'lease claim changed; retry' >&2
        exit 23
      fi
      trap 'rmdir "$XDG_STATE_HOME/copy.lock"' EXIT
      sleep 0.05
    fi
    source=
    destination=
    for value in "$@"; do source="$destination"; destination="$value"; done
    source="\${source#SANDBOX:}"
    destination="\${destination#SANDBOX:}"
    /bin/cp "$source" "$destination"
    ;;
  tunnel)
    if [ -n "$CRABBOX_TEST_TUNNEL_DELAY" ]; then
      exec node -e 'require("node:fs").writeFileSync(process.env.CRABBOX_TEST_TUNNEL_PID, String(process.pid)); setTimeout(() => console.log(JSON.stringify({ port: 49152 })), 10000)'
    fi
    exec node -e 'const net=require("node:net");const server=net.createServer(socket=>socket.end());server.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({port:server.address().port,remotePort:3000})))'
    ;;
  *) exit 21 ;;
esac
`)
  await chmod(command, 0o755)
}

async function executable(bin: string, name: string, body: string) {
  const path = join(bin, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
}

async function withEnvironment<T>(environment: Record<string, string>, run: () => Promise<T>) {
  const original = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]))
  Object.assign(process.env, environment)
  try {
    return await run()
  }
  finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

async function waitForFile(path: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await stat(path).then(() => true, () => false)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${path}`)
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}
