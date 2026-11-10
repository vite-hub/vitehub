import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { build } from "esbuild"
import { expect, it } from "vitest"

const execFileAsync = promisify(execFile)

it("runs Database request state through Nuxt's facade alias", async () => {
  const result = await build({
    alias: {
      "@vite-hub/database/runtime/state": fileURLToPath(new URL("../src/internal/database-runtime-state.ts", import.meta.url)),
    },
    bundle: true,
    format: "esm",
    platform: "node",
    stdin: {
      contents: [
        'import { getRequestCloudflareEnv, runWithDatabaseRequest } from "@vite-hub/database/runtime/state"',
        'const env = { DATABASE: "request-binding" }',
        'const event = { "~standard": { vendor: "test", req: new Request("https://example.test/"), res: { headers: new Headers() }, runtime: { cloudflare: { env } } } }',
        "console.log(getRequestCloudflareEnv(event) === env)",
        "console.log(await runWithDatabaseRequest(event, () => 42))",
      ].join("\n"),
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    },
    write: false,
  })
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", result.outputFiles[0]!.text])
  expect(stdout.trim()).toBe("true\n42")
})
