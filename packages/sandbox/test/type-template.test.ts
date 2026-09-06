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

import { createSandboxTypeTemplateContents } from "../src/type-template.ts"

describe("createSandboxTypeTemplateContents", () => {
  it("generates callable package contracts", () => {
    const contents = createSandboxTypeTemplateContents([
      {
        handler: "/app/server/sandboxes/typed/index.ts",
        kind: "package-entry",
        name: "typed",
      },
      {
        handler: "/app/server/sandboxes/untyped/index.ts",
        kind: "package-entry",
        name: "untyped",
      },
    ])

    expect(contents).toContain("type SandboxPackageContract<TDefault extends (...args: any[]) => any>")
    expect(contents).toContain('"typed": SandboxPackageContract<typeof import("/app/server/sandboxes/typed/index.ts")[\'default\']>')
    expect(contents).toContain('"untyped": SandboxPackageContract<typeof import("/app/server/sandboxes/untyped/index.ts")[\'default\']>')
  })

  it("type-checks inferred function payloads and results", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-types-"))
    try {
      const callable = join(root, "callable.ts")
      const zeroArgument = join(root, "zero-argument.ts")
      const generated = join(root, "sandbox.d.ts")
      const assertions = join(root, "assertions.ts")
      const stubs = join(root, "stubs.d.ts")
      await Promise.all([
        writeFile(callable, "export default async function (payload: { image: Blob }) { return { size: payload.image.size } }\n"),
        writeFile(zeroArgument, "export default async function () { return 'ready' as const }\n"),
        writeFile(stubs, "declare module '@vite-hub/sandbox' { export interface SandboxDefinitionBundle {} export interface SandboxDefinitionOptions {} }\n"),
        writeFile(generated, createSandboxTypeTemplateContents([
          { handler: callable, kind: "package-entry", name: "callable" },
          { handler: zeroArgument, kind: "package-entry", name: "zero-argument" },
        ])),
        writeFile(assertions, [
          `type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false`,
          `type Assert<T extends true> = T`,
          `type Definitions = import("#vitehub-sandbox-registry").SandboxDefinitionModules`,
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
