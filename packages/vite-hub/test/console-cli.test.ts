import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { runConsoleDevCli } from "../src/console/cli.ts"
import { consoleFixtureEnvironmentVariable, consoleFixtureFallbackAgentName, parseConsoleFixture } from "../src/console/fixture.ts"

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
    const stderr = stream()
    const stdout = stream()
    const cli = context(root, { spawn, stderr, stdout })

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
    expect(stdout.output()).toContain("(1 invocation)")
    expect(stderr.output()).toBe("")
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

  it("starts a command with a selectable identity for fixture invocations without an Agent name", async () => {
    const { fixture, root } = await fixtureRoot()
    const fixtureValue = JSON.parse(await readFile(fixture, "utf8"))
    delete fixtureValue.invocations[0].agentName
    await writeFile(fixture, JSON.stringify(fixtureValue))
    const spawn = vi.fn(async () => ({ exitCode: 0 }))
    const stderr = stream()
    const cli = context(root, { spawn, stderr })

    await expect(runConsoleDevCli(["--fixture", fixture, "--", "pnpm", "dev"], cli)).resolves.toBe(0)

    expect(spawn).toHaveBeenCalledOnce()
    expect(parseConsoleFixture(fixtureValue).invocations[0]?.agentName)
      .toBe(consoleFixtureFallbackAgentName)
    expect(stderr.output()).toBe("")
  })

  it("normalizes fixture Agent names for Console selection", () => {
    const fixture = parseConsoleFixture({
      invocations: [
        {
          agentName: " support ",
          createdAt: "2026-08-27T10:00:00.000Z",
          id: "fixture-invocation",
          observations: [],
          status: "completed",
          traceId: "fixture-trace",
          updatedAt: "2026-08-27T10:01:00.000Z",
        },
      ],
      version: 1,
    })

    expect(fixture.invocations[0]?.agentName).toBe("support")
  })

  it("rejects non-string fixture cursors", () => {
    expect(() => parseConsoleFixture({
      invocations: [{
        agentName: "support",
        createdAt: "2026-08-27T00:00:00.000Z",
        cursor: 42,
        id: "fixture-invocation",
        observations: [],
        status: "completed",
        traceId: "fixture-trace",
        updatedAt: "2026-08-27T00:00:00.000Z",
      }],
      version: 1,
    })).toThrow("Console fixture invocations[0].cursor must be a string")
  })

  it.each([".", ".."])('rejects the dot-segment fixture invocation ID "%s"', (id) => {
    expect(() => parseConsoleFixture({
      invocations: [{
        agentName: "support",
        createdAt: "2026-08-27T00:00:00.000Z",
        id,
        observations: [],
        status: "completed",
        traceId: "fixture-trace",
        updatedAt: "2026-08-27T00:00:00.000Z",
      }],
      version: 1,
    })).toThrow("Console fixture invocations[0].id must not be a dot segment")
  })

  it("rejects fixture invocation IDs that cannot be URL-encoded", () => {
    expect(() => parseConsoleFixture({
      invocations: [{
        agentName: "support",
        createdAt: "2026-08-27T00:00:00.000Z",
        id: "fixture-\uD800",
        observations: [],
        status: "completed",
        traceId: "fixture-trace",
        updatedAt: "2026-08-27T00:00:00.000Z",
      }],
      version: 1,
    })).toThrow("Console fixture invocations[0].id must contain well-formed Unicode")
  })

  it("rejects fixture Agent names that the Console API cannot select", () => {
    expect(() => parseConsoleFixture({
      invocations: [
        {
          agentName: "a".repeat(513),
          createdAt: "2026-08-27T10:00:00.000Z",
          id: "fixture-invocation",
          observations: [],
          status: "completed",
          traceId: "fixture-trace",
          updatedAt: "2026-08-27T10:01:00.000Z",
        },
      ],
      version: 1,
    })).toThrow("invocations[0].agentName must be at most 512 characters")
  })

  it("rejects fixture Agent names that cannot be URL-encoded", () => {
    expect(() => parseConsoleFixture({
      invocations: [
        {
          agentName: "support-\uD800",
          createdAt: "2026-08-27T10:00:00.000Z",
          id: "fixture-invocation",
          observations: [],
          status: "completed",
          traceId: "fixture-trace",
          updatedAt: "2026-08-27T10:01:00.000Z",
        },
      ],
      version: 1,
    })).toThrow("invocations[0].agentName must contain well-formed Unicode")
  })

  it("rejects arrays for every record-shaped fixture field", () => {
    const invocation = {
      agentName: "support",
      createdAt: "2026-08-27T10:00:00.000Z",
      id: "fixture-invocation",
      observations: [],
      status: "completed",
      traceId: "fixture-trace",
      updatedAt: "2026-08-27T10:01:00.000Z",
    }
    const fixture = (overrides: Record<string, unknown>) => ({
      invocations: [{ ...invocation, ...overrides }],
      version: 1,
    })

    expect(() => parseConsoleFixture([])).toThrow("Console fixture must be a JSON object")
    expect(() => parseConsoleFixture({ invocations: [[]], version: 1 })).toThrow(
      "invocations[0] must be an object",
    )
    expect(() => parseConsoleFixture(fixture({ annotations: [] }))).toThrow(
      "invocations[0].annotations must be an object",
    )
    expect(() => parseConsoleFixture(fixture({ error: [] }))).toThrow(
      "invocations[0].error must be an object",
    )
    expect(() =>
      parseConsoleFixture(
        fixture({
          observations: [
            {
              attributes: [],
              name: "agent.start",
              sequence: 0,
              timestamp: "2026-08-27T10:00:00.000Z",
              type: "run",
            },
          ],
        }),
      ),
    ).toThrow("invocations[0].observations[0].attributes must be an object")
    expect(() =>
      parseConsoleFixture(
        fixture({
          observations: [
            {
              attributes: { nested: [{ value: Number.POSITIVE_INFINITY }] },
              name: "agent.start",
              sequence: 0,
              timestamp: "2026-08-27T10:00:00.000Z",
              type: "run",
            },
          ],
        }),
      ),
    ).toThrow('invocations[0].observations[0].attributes["nested"][0]["value"] must be a finite number')
    expect(() =>
      parseConsoleFixture(
        fixture({
          observations: [
            {
              name: "agent.start",
              sequence: 0,
              timestamp: "2026-08-27T10:00:00.000Z",
              trace: [],
              type: "run",
            },
          ],
        }),
      ),
    ).toThrow("invocations[0].observations[0].trace must be an object")
  })

  it.each([{}, [], Number.POSITIVE_INFINITY])(
    "rejects malformed fixture annotation value %#",
    (annotation) => {
      expect(() => parseConsoleFixture({
        invocations: [{
          agentName: "support",
          annotations: { "github.title": annotation },
          createdAt: "2026-08-27T10:00:00.000Z",
          id: "fixture-invocation",
          observations: [],
          status: "completed",
          traceId: "fixture-trace",
          updatedAt: "2026-08-27T10:01:00.000Z",
        }],
        version: 1,
      })).toThrow(
        'invocations[0].annotations["github.title"] must be a boolean, finite number, string, or null',
      )
    },
  )

  it("rejects duplicate observation sequence numbers within an invocation", () => {
    const observation = {
      name: "agent.start",
      sequence: 0,
      timestamp: "2026-08-27T10:00:00.000Z",
      type: "run",
    }

    expect(() => parseConsoleFixture({
      invocations: [{
        agentName: "support",
        createdAt: "2026-08-27T10:00:00.000Z",
        id: "fixture-invocation",
        observations: [observation, { ...observation, name: "agent.finish" }],
        status: "completed",
        traceId: "fixture-trace",
        updatedAt: "2026-08-27T10:01:00.000Z",
      }],
      version: 1,
    })).toThrow("invocations[0] contains duplicate observation sequence 0")
  })

  it("rejects non-boolean fixture truncation metadata", () => {
    expect(() => parseConsoleFixture({
      invocations: [{
        agentName: "support",
        createdAt: "2026-08-27T10:00:00.000Z",
        id: "fixture-invocation",
        observations: [],
        observationsTruncated: "true",
        status: "completed",
        traceId: "fixture-trace",
        updatedAt: "2026-08-27T10:01:00.000Z",
      }],
      version: 1,
    })).toThrow("invocations[0].observationsTruncated must be a boolean")
  })

  it.each([
    [{}, "invocations[0].error.message must be a non-empty string"],
    [{ message: 42 }, "invocations[0].error.message must be a non-empty string"],
    [
      { cause: {}, message: "outer" },
      "invocations[0].error.cause.message must be a non-empty string",
    ],
    [
      { errors: [{}], message: "outer" },
      "invocations[0].error.errors[0].message must be a non-empty string",
    ],
    [
      { details: { retry: { attempts: Number.POSITIVE_INFINITY } }, message: "failed" },
      'invocations[0].error.details["retry"]["attempts"] must be a finite number',
    ],
    [
      { message: "failed", metadata: { score: Number.POSITIVE_INFINITY } },
      'invocations[0].error["metadata"]["score"] must be a finite number',
    ],
  ])("rejects malformed fixture diagnostic errors %#", (error, message) => {
    expect(() =>
      parseConsoleFixture({
        invocations: [
          {
            agentName: "support",
            createdAt: "2026-08-27T10:00:00.000Z",
            error,
            id: "fixture-invocation",
            observations: [],
            status: "failed",
            traceId: "fixture-trace",
            updatedAt: "2026-08-27T10:01:00.000Z",
          },
        ],
        version: 1,
      }),
    ).toThrow(message)
  })

  it("translates child termination signals to shell exit statuses", async () => {
    const { root } = await fixtureRoot()
    const stderr = stream()
    const cli = context(root, {
      spawn: vi.fn(async () => ({ exitCode: null, signal: "SIGTERM" as const })),
      stderr,
    })

    await expect(
      runConsoleDevCli(["--fixture", "console.fixture.json", "--", "pnpm", "dev"], cli),
    ).resolves.toBe(143)

    expect(stderr.output()).toBe("")
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
