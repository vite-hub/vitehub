import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { runConsoleDevCli } from "../src/console/cli.ts"
import { consoleFixtureEnvironmentVariable } from "../src/console/fixture.ts"

import type { ViteHubCliContext } from "@vite-hub/internal/cli"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  )
})
function stream() {
  let value = ""
  return {
    output: () => value,
    write(chunk: string | Uint8Array) {
      value += String(chunk)
      return true
    },
  }
}

async function fixtureRoot(): Promise<{ fixture: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-console-fixture-"))
  directories.push(root)
  const fixture = join(root, "console.fixture.json")
  await writeFile(
    fixture,
    JSON.stringify({
      invocations: [
        {
          agentName: "support",
          createdAt: "2026-08-27T10:00:00.000Z",
          id: "fixture-invocation",
          observations: [],
          status: "completed",
          traceId: "fixture-trace",
          updatedAt: "2026-08-27T10:01:00.000Z",
        },
      ],
      version: 1,
    }),
  )
  return { fixture, root }
}

function context(root: string, overrides: Partial<ViteHubCliContext> = {}): ViteHubCliContext {
  return {
    cwd: root,
    env: { EXISTING_VALUE: "preserved" },
    rootDir: root,
    spawn: vi.fn(async () => ({ exitCode: 0 })),
    stderr: stream(),
    stdout: stream(),
    ...overrides,
  }
}

describe("Console fixture CLI", () => {
  it("validates the fixture before starting the caller's development command", async () => {
    const { root } = await fixtureRoot()
    const spawn = vi.fn(async () => ({ exitCode: 7 }))
    const cli = context(root, { spawn })

    await expect(
      runConsoleDevCli(["--fixture", "console.fixture.json", "--", "pnpm", "dev", "--host"], cli),
    ).resolves.toBe(7)

    expect(spawn).toHaveBeenCalledWith("pnpm", ["dev", "--host"], {
      cwd: root,
      env: {
        EXISTING_VALUE: "preserved",
        [consoleFixtureEnvironmentVariable]: join(root, "console.fixture.json"),
      },
    })
    expect((cli.stdout as ReturnType<typeof stream>).output()).toContain("(1 invocation)")
    expect((cli.stderr as ReturnType<typeof stream>).output()).toBe("")
  })

  it("does not start a command for malformed fixture data", async () => {
    const { fixture, root } = await fixtureRoot()
    await writeFile(fixture, JSON.stringify({ invocations: [], version: 2 }))
    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const stderr = stream()
    const cli = context(root, { spawn, stderr })

    await expect(runConsoleDevCli(["--fixture", fixture, "--", "pnpm", "dev"], cli)).resolves.toBe(
      1,
    )

    expect(spawn).not.toHaveBeenCalled()
    expect(stderr.output()).toContain("Console fixture version must be 1")
  })

  it("requires both a fixture and an explicit development command", async () => {
    const { root } = await fixtureRoot()
    const stderr = stream()
    const cli = context(root, { stderr })

    await expect(runConsoleDevCli(["--fixture", "console.fixture.json"], cli)).resolves.toBe(1)

    expect(stderr.output()).toContain("requires a development command after --")
    expect(stderr.output()).toContain("Usage: vitehub console dev")
  })
})
