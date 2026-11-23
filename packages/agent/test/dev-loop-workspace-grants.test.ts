import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { it } from "vitest"

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL("..", import.meta.url))

it("shares Agent Scope and Workspace Store grants between Node and Vite SSR", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-dev-loop-grants-"))
  try {
    await mkdir(join(root, "server/agents"), { recursive: true })
    await mkdir(join(root, "server/workspaces"), { recursive: true })
    await mkdir(join(root, "node_modules/@vite-hub"), { recursive: true })
    await symlink(packageRoot, join(root, "node_modules/@vite-hub/agent"), "dir")
    await symlink(join(packageRoot, "../workspace"), join(root, "node_modules/@vite-hub/workspace"), "dir")
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "dev-loop-grants", type: "module" }))
    await writeFile(join(root, "server/workspaces/docs.ts"), `export default { store: { driver: "memory" } }`)
    await writeFile(join(root, "server/agents/probe.ts"), `
      import { defineAgent } from "@vite-hub/agent"
      import { access } from "@vite-hub/agent/capabilities"
      export default defineAgent({
        workspace: "docs",
        capabilities: [access({ workspace: { resolve: { all: true, role: "admin", scope: "all" } } })],
        driver: { run: () => "scope applied" },
      })
    `)
    await writeFile(join(root, "store-target.ts"), `export { resolveWorkspaceStoreTarget } from "@vite-hub/workspace/files"`)

    await execFileAsync(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict"
      import { EventEmitter } from "node:events"
      import { Readable } from "node:stream"
      import { hubAgent } from "@vite-hub/agent/vite"
      import { getWorkspaceHostedStoreLoader } from "@vite-hub/workspace/runtime"
      import { readWorkspaceDevToken, workspaceDevTokenHeader, workspaceDevTokenServerId } from "@vite-hub/workspace/server"
      import { hubWorkspace } from "@vite-hub/workspace/vite"
      import { createServer } from "vite"

      const root = ${JSON.stringify(root)}
      const server = await createServer({
        appType: "custom", configFile: false, logLevel: "silent", root,
        plugins: [hubWorkspace(), hubAgent()], server: { middlewareMode: true, ws: false, cors: false },
      })
      function request(method, headers, input) {
        const req = Object.assign(Readable.from(input ? [JSON.stringify(input)] : []), {
          method, headers: { host: "localhost", "x-vitehub-agent-dev-loop": "1", ...headers },
          url: "/__vitehub/agent/invocation-stream",
        })
        return new Promise((resolve, reject) => {
          let body = ""
          const res = Object.assign(new EventEmitter(), {
            setHeader() {},
            destroy: reject,
            write(chunk) { body += Buffer.from(chunk).toString(); return true },
            end(chunk) {
              if (chunk) this.write(chunk)
              resolve({ body, status: this.statusCode })
            },
          })
          server.middlewares(req, res, error => reject(error ?? new Error("Missing Dev Loop middleware for " + method)))
        })
      }
      try {
        const discovery = await request("GET")
        assert.equal(discovery.status, 200, discovery.body)
        assert.deepEqual(JSON.parse(discovery.body).agents.map(agent => agent.name), ["probe"])

        const githubStore = getWorkspaceHostedStoreLoader()({ driver: "github", repo: "example/docs", token: "unused" }, "github-docs")
        const { resolveWorkspaceStoreTarget } = await server.ssrLoadModule("/store-target.ts")
        const provider = (await resolveWorkspaceStoreTarget(githubStore))?.provider

        const token = await readWorkspaceDevToken(root, { serverId: workspaceDevTokenServerId(server.config.server.port) })
        const { body, status } = await request("POST", { [workspaceDevTokenHeader]: token, "content-type": "application/json" }, {
          agent: "probe", messages: [{ role: "user", parts: [{ type: "text", text: "check scope" }] }],
        })
        assert.equal(status, 200, body)
        assert.deepEqual({ applied: body.includes("scope applied"), provider }, { applied: true, provider: "github" }, body)
      }
      finally {
        await server.close()
      }
    `], { cwd: packageRoot, timeout: 30_000 })
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}, 35_000)
