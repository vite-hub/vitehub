import { describe, expectTypeOf, it } from "vitest"

import {
  defineSandboxTask,
  resolveSandboxTaskRunner,
  runSandboxTask,
  type AgentSandboxTaskConfig,
  type SandboxTaskDefinition,
  type SandboxTaskRunResult,
  type SandboxTaskRunner,
} from "../../src/task/index.ts"
import { hubSandboxTask, type SandboxTaskOptions } from "../../src/task/vite.ts"

declare module "#vitehub-sandbox-task-registry" {
  interface SandboxTaskDefinitionModules {
    "package-entry": {
      payload: { value: string }
      result: { length: number }
    }
    "unknown-package-entry": {
      payload: unknown
      result: string
    }
    "optional-package-entry": {
      payload: { value: string } | undefined
      result: string
    }
  }
}

describe("types", () => {
  it("accepts a handler with a required payload", () => {
    const definition = defineSandboxTask({
      timeout: 60000,
      handler: async (payload: { width: number }) => ({ width: payload.width }),
    })

    expectTypeOf(definition.handler).parameter(0).toEqualTypeOf<{ width: number }>()
  })

  it("requires the payload declared by a registered task", () => {
    // @ts-expect-error A task with a required payload cannot be invoked without it.
    void runSandboxTask("package-entry")
    // @ts-expect-error A task with a required payload cannot receive undefined.
    void runSandboxTask("package-entry", undefined)
    // @ts-expect-error The fallback for unregistered names must not hide an invalid payload.
    void runSandboxTask("package-entry", { width: 1 })

    expectTypeOf(runSandboxTask("optional-package-entry")).resolves.toEqualTypeOf<Response>()
    expectTypeOf(runSandboxTask("optional-package-entry", undefined)).resolves.toEqualTypeOf<Response>()
    expectTypeOf(runSandboxTask("unknown-package-entry")).resolves.toEqualTypeOf<Response>()
    expectTypeOf(runSandboxTask("unregistered-entry")).resolves.toEqualTypeOf<Response>()
  })

  it("requires typed runner payloads while allowing optional payloads", async () => {
    const inferredRunner = await resolveSandboxTaskRunner("package-entry")
    expectTypeOf(inferredRunner.run({ value: "ok" })).resolves.toEqualTypeOf<{ length: number }>()
    // @ts-expect-error Registry inference requires the task's payload on the runner too.
    void inferredRunner.run()
    // @ts-expect-error Registry inference rejects a different payload shape.
    void inferredRunner.run({ width: 1 })

    const runner = await resolveSandboxTaskRunner<{ value: string }, { length: number }>("package-entry")
    expectTypeOf(runner.run({ value: "ok" })).resolves.toEqualTypeOf<{ length: number }>()
    // @ts-expect-error The resolved runner requires its declared payload.
    void runner.run()
    // @ts-expect-error The resolved runner rejects an undefined payload.
    void runner.run(undefined)
    // @ts-expect-error The resolved runner rejects a different payload shape.
    void runner.run({ width: 1 })

    const optionalRunner = await resolveSandboxTaskRunner<{ value: string } | undefined>("optional-package-entry")
    void optionalRunner.run()
    const genericRunner = {} as SandboxTaskRunner
    // @ts-expect-error An explicitly typed runner call requires its payload.
    void genericRunner.run<{ value: string }>()
    void genericRunner.run()
  })

  it("types the sandboxTask plugin options", () => {
    const options: SandboxTaskOptions = {
      provider: "cloudflare",
      binding: "SANDBOX",
      name: "custom-sandbox",
    }

    expectTypeOf(options).toMatchTypeOf<AgentSandboxTaskConfig | false>()
    expectTypeOf(hubSandboxTask).parameter(0).toMatchTypeOf<SandboxTaskOptions | undefined>()
  })

  it("types sandbox definitions and run results", async () => {
    const definition = defineSandboxTask({
      project: false,
      handler: async (payload?: { value: string }) => ({ value: payload?.value || "" }),
    })

    expectTypeOf(definition).toMatchTypeOf<SandboxTaskDefinition<{ value: string } | undefined, { value: string }>>()
    expectTypeOf(runSandboxTask("release-notes", { value: "ok" })).resolves.toMatchTypeOf<SandboxTaskRunResult>()
    expectTypeOf(runSandboxTask("package-entry", { value: "ok" })).resolves.toEqualTypeOf<SandboxTaskRunResult>()
    expectTypeOf(runSandboxTask("unknown-package-entry", { anything: true })).resolves.toEqualTypeOf<SandboxTaskRunResult>()

    const result = await runSandboxTask("package-entry", { value: "ok" })
    expectTypeOf(result).toEqualTypeOf<Response>()
  })

  it("returns a Vite plugin", () => {
    const plugin = hubSandboxTask()

    expectTypeOf(hubSandboxTask({ provider: "cloudflare" })).toMatchTypeOf<typeof plugin>()
  })
})
