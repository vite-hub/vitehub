import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { runAgentEvalite } from "../src/evalite-runner.ts"

const createVitestCalls = vi.hoisted(() => [] as Array<{ setupFiles?: string[] }>)

vi.mock("evalite/backend-only-constants", () => ({
  FILES_LOCATION: ".evalite",
}))

vi.mock("evalite/constants", () => ({
  DEFAULT_SERVER_PORT: 3006,
}))

vi.mock("evalite/reporter", () => ({
  default: class EvaliteReporter {},
}))

vi.mock("evalite/server", () => ({
  createServer: () => ({
    setRerunFn: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    updateState: vi.fn(),
  }),
}))

vi.mock("evalite/in-memory-storage", () => ({
  createInMemoryStorage: () => ({}),
}))

vi.mock("vitest/config", () => ({
  configDefaults: {
    forceRerunTriggers: [],
  },
}))

vi.mock("vitest/node", () => ({
  createVitest: vi.fn(async (_mode: string, options: { setupFiles?: string[] }) => {
    createVitestCalls.push(options)
    return {
      close: vi.fn(),
      getModuleSpecifications: vi.fn(() => []),
      provide: vi.fn(),
      shouldKeepServer: vi.fn(() => false),
      start: vi.fn(),
      state: {
        getFilepaths: vi.fn(() => []),
      },
    }
  }),
  registerConsoleShortcuts: vi.fn(() => vi.fn()),
}))

describe("Agent Evalite runner", () => {
  afterEach(() => {
    createVitestCalls.length = 0
  })

  it("resolves Evalite setup file from the Agent Package before app setup files", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "vitehub-agent-evalite-"))
    try {
      await runAgentEvalite({
        cwd,
        forceRerunTriggers: [],
        mode: "run-once-and-exit",
        setupFiles: ["./app-setup.ts"],
      })

      const setupFiles = createVitestCalls[0]?.setupFiles ?? []
      const evaliteSetupFile = setupFiles[0] ?? ""
      expect(evaliteSetupFile).not.toBe("evalite/env-setup-file")
      expect(path.isAbsolute(evaliteSetupFile)).toBe(true)
      expect(evaliteSetupFile).toMatch(/node_modules\/evalite\/setup-files\/env\.js$/)
      expect(setupFiles.slice(1)).toEqual(["./app-setup.ts"])
    }
    finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })
})
