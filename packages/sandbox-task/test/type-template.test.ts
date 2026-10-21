import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createProgram,
  flattenDiagnosticMessageText,
  getPreEmitDiagnostics,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
} from "typescript"
import { describe, expect, it } from "vitest"

import { createSandboxTaskTypeTemplateContents } from "../src/type-template.ts"

describe("createSandboxTaskTypeTemplateContents", () => {
  it("generates callable package contracts", () => {
    const contents = createSandboxTaskTypeTemplateContents([
      {
        handler: "/app/server/sandbox-tasks/typed/index.ts",
        kind: "package-entry",
        name: "typed",
      },
      {
        handler: "/app/server/sandbox-tasks/untyped/index.ts",
        kind: "package-entry",
        name: "untyped",
      },
    ])

    expect(contents).toContain("type SandboxTaskPackageContract<TDefault extends (...args: any[]) => any>")
    expect(contents).toContain('"typed": SandboxTaskPackageContract<typeof import("/app/server/sandbox-tasks/typed/index.ts")[\'default\']>')
    expect(contents).toContain('"untyped": SandboxTaskPackageContract<typeof import("/app/server/sandbox-tasks/untyped/index.ts")[\'default\']>')
  })

  it("type-checks inferred function payloads and results", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-task-types-"))
    try {
      const callable = join(root, "callable.ts")
      const zeroArgument = join(root, "zero-argument.ts")
      const generated = join(root, "sandbox-task.d.ts")
      const assertions = join(root, "assertions.ts")
      const stubs = join(root, "stubs.d.ts")
      await Promise.all([
        writeFile(callable, "export default async function (payload: { image: Blob }) { return { size: payload.image.size } }\n"),
        writeFile(zeroArgument, "export default async function () { return 'ready' as const }\n"),
        writeFile(stubs, "declare module '@vite-hub/sandbox-task' { export interface SandboxTaskDefinitionBundle {} export interface SandboxTaskDefinitionOptions {} }\n"),
        writeFile(generated, createSandboxTaskTypeTemplateContents([
          { handler: callable, kind: "package-entry", name: "callable" },
          { handler: zeroArgument, kind: "package-entry", name: "zero-argument" },
        ])),
        writeFile(assertions, [
          `type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false`,
          `type Assert<T extends true> = T`,
          `type Definitions = import("#vitehub-sandbox-task-registry").SandboxTaskDefinitionModules`,
          `type CallablePayload = Assert<Equal<Definitions["callable"]["payload"], { image: Blob }>>`,
          `type CallableResult = Assert<Equal<Definitions["callable"]["result"], { size: number }>>`,
          `type ZeroArgumentPayload = Assert<Equal<Definitions["zero-argument"]["payload"], unknown>>`,
          `type ZeroArgumentResult = Assert<Equal<Definitions["zero-argument"]["result"], "ready">>`,
          `export type Assertions = CallablePayload | CallableResult | ZeroArgumentPayload | ZeroArgumentResult`,
          ``,
        ].join("\n")),
      ])

      const program = createProgram({
        options: {
          allowImportingTsExtensions: true,
          module: ModuleKind.ESNext,
          moduleResolution: ModuleResolutionKind.Bundler,
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: ScriptTarget.ES2023,
        },
        rootNames: [assertions, callable, generated, stubs, zeroArgument],
      })
      expect(getPreEmitDiagnostics(program).map(diagnostic => flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
