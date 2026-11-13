import { fileURLToPath } from "node:url"
import ts from "typescript"
import { expect, it } from "vitest"

/** Type-checks `source` as a file next to these tests and returns its error messages. */
function typeErrors(source: string): string[] {
  const config = ts.getParsedCommandLineOfConfigFile(fileURLToPath(new URL("../tsconfig.json", import.meta.url)), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
    },
  })!
  // TypeScript names files with forward slashes on every platform.
  const file = fileURLToPath(new URL("./define-auth-probe.ts", import.meta.url)).replaceAll("\\", "/")
  const host = ts.createCompilerHost(config.options)
  const { fileExists, getSourceFile } = host
  host.fileExists = name => name === file || fileExists(name)
  host.getSourceFile = (name, ...rest) => name === file ? ts.createSourceFile(name, source, ts.ScriptTarget.ESNext) : getSourceFile(name, ...rest)
  const program = ts.createProgram([file], config.options, host)
  return ts.getPreEmitDiagnostics(program, program.getSourceFile(file)).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
}

// A full program loads the Better Auth types, which takes seconds.
it("rejects the removed runtime option in a typed Definition", { timeout: 60_000 }, () => {
  const errors = typeErrors(`
    import { defineAuth } from "../src/index.ts"

    defineAuth({
      advanced: { cookiePrefix: "acme" },
      runtime: () => ({ advanced: { trustedProxyHeaders: true } }),
    })
  `)
  expect(errors).toHaveLength(1)
  expect(errors[0]).toContain("Type '() => { advanced: { trustedProxyHeaders: boolean; }; }' is not assignable to type 'undefined'")
})

it("names the wrong secondary storage member in a Definition callback", { timeout: 60_000 }, () => {
  const errors = typeErrors(`
    import { defineAuth } from "../src/index.ts"

    defineAuth(() => ({
      emailAndPassword: { enabled: true },
      secondaryStorage: { get: (key: string) => key, set: () => {}, delete: () => {} },
      secret: "define-auth-types-secret-abcdefghijklmnopqrstuvwxyz",
    }))
  `)
  expect(errors).toHaveLength(1)
  expect(errors[0]).toContain("is missing the following properties from type 'SecondaryStorage': getAndDelete, increment")
})
