import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"
import { expect, it } from "vitest"

it("typechecks published Gateways and Decisions roots without the optional AI SDK", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-decisions-no-ai-"))
  try {
    const packages = [
      ["@vite-hub/decisions", fileURLToPath(new URL("../", import.meta.url))],
      ["@vite-hub/gateways", fileURLToPath(new URL("../../gateways/", import.meta.url))],
      ["nostics", dirname(fileURLToPath(import.meta.resolve("nostics/package.json")))],
    ] as const
    for (const [name, source] of packages) {
      const target = join(root, "node_modules", name)
      await mkdir(target, { recursive: true })
      await cp(join(source, "package.json"), join(target, "package.json"))
      await cp(join(source, "dist"), join(target, "dist"), { recursive: true })
    }
    const entry = join(root, "consumer.mts")
    await writeFile(entry, `
      import { askWithModel, typesafe } from '@vite-hub/gateways'
      import { defineChoices } from '@vite-hub/decisions'
      const groups = { chart: { label: 'Chart', options: [{ label: 'Bar', value: 'bar' }] } }
      const choices = defineChoices({ gateway: typesafe(), groups })
      const result = choices.resolve('bar')
      defineChoices({ model: 'openai/gpt-5.1-mini', groups })
      askWithModel('openai/gpt-5.1-mini')
      // @ts-expect-error A model must implement the AI SDK model contract.
      askWithModel({})
    `)
    const options: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, noEmit: true, strict: true, target: ts.ScriptTarget.ESNext, types: [] }
    for (const peer of ["ai", "@ai-sdk/provider"]) {
      expect(ts.resolveModuleName(peer, entry, options, ts.sys).resolvedModule).toBeUndefined()
    }
    const program = ts.createProgram([entry], options)
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
