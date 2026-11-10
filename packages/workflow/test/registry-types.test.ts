import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import ts from "typescript"
import { describe, expect, it } from "vitest"

import { createWorkflowTypes } from "../src/internal/registry-types.ts"

describe("generated Workflow types", () => {
  it.each(["@vite-hub/workflow", "vite-hub/workflow"].flatMap(importBase => [false, true].map(allowJs => ({ allowJs, importBase }))))("supports steps through $importBase with allowJs: $allowJs", async ({ allowJs, importBase }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-js-types-"))
    try {
      await mkdir(join(root, "node_modules/@vite-hub"), { recursive: true })
      await symlink(resolve(import.meta.dirname, ".."), join(root, "node_modules/@vite-hub/workflow"), "dir")
      const steps = ["javascript.js", "module.mjs", "commonjs.cjs", "typed.ts"].map(file => join(root, file))
      for (const step of steps) {
        await writeFile(step, step.endsWith(".cjs")
          ? "module.exports = (input = 1) => input + 1\n"
          : step.endsWith(".ts")
            ? "export default (input: number) => String(input)\n"
            : "export default (input = 1) => input + 1\n")
      }
      const declaration = join(root, "workflow.d.ts")
      await writeFile(declaration, createWorkflowTypes(declaration, [{ handler: root, name: "release", steps }], importBase))
      const entry = join(root, "index.mts")
      await writeFile(entry, [
        'import { defineWorkflow } from "@vite-hub/workflow"',
        'import { defineWorkflow as definePublicWorkflow } from "vite-hub/workflow"',
        "for (const define of [defineWorkflow, definePublicWorkflow]) {",
        'define("release", async (_payload, { steps }) => {',
        "  await steps.javascript()",
        "  await steps.module(1)",
        "  await steps.commonjs()",
        "  const result: string = await steps.typed(1)",
        "  // @ts-expect-error TypeScript step inputs remain checked.",
        '  await steps.typed("wrong")',
        "  // @ts-expect-error Undiscovered steps remain unavailable through every import form.",
        "  await steps.missing()",
        ...(allowJs ? [
          "  const inferred: number = await steps.javascript(1)",
          "  // @ts-expect-error JavaScript inference remains available with allowJs.",
          '  await steps.javascript("wrong")',
          "  return inferred",
        ] : ["  return result"]),
        "})",
        "}",
      ].join("\n"))
      const program = ts.createProgram([entry, declaration], {
        allowImportingTsExtensions: true, allowJs, module: ts.ModuleKind.NodeNext,
        noEmit: true, noUncheckedIndexedAccess: true, skipLibCheck: false, strict: true, target: ts.ScriptTarget.ESNext,
        // Use the distribution's real barrels without building its unrelated integrations.
        paths: {
          "vite-hub/workflow": [resolve(import.meta.dirname, "../../vite-hub/src/workflow.ts")],
        },
      })
      expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("declares the step files of each folder Workflow", () => {
    expect(createWorkflowTypes("/app/.vitehub/workflow.d.ts", [
      {
        handler: "/app/server/workflows/onboard-user/index.ts",
        name: "onboard-user",
        steps: ["/app/server/workflows/onboard-user/01.create-user.ts", "/app/server/workflows/onboard-user/02-send-welcome.ts"],
      },
      { handler: "/app/server/workflows/cleanup.ts", name: "cleanup" },
      { handler: "/app/server/workflows/digest", name: "digest", steps: ["/app/server/workflows/digest/1.collect.ts"] },
    ], "vite-hub/workflow")).toBe([
      "import \"vite-hub/workflow\"",
      "declare module \"vite-hub/workflow\" {",
      "  interface WorkflowStepRegistry {",
      "    \"onboard-user\": {",
      "      \"createUser\": typeof import(\"../server/workflows/onboard-user/01.create-user.ts\").default",
      "      \"sendWelcome\": typeof import(\"../server/workflows/onboard-user/02-send-welcome.ts\").default",
      "    }",
      "    \"digest\": {",
      "      \"collect\": typeof import(\"../server/workflows/digest/1.collect.ts\").default",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n"))
  })
})
