import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { expect, it } from "vitest"

it("pages approvals through the vitehub executable without JSON tips or prompts", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-connections-cli-page-"))
  const base = { action: "mail.messages.modify", actor: "agent:mail", createdAt: "2026-09-29T08:00:00.000Z", input: {}, name: "mail", status: "pending" }
  const requests: unknown[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    // SAFETY: The executable owns the JSON request shape sent to this local test server.
    const input = JSON.parse(Buffer.concat(chunks).toString()) as { action: string, before?: string, id?: string }
    requests.push(input)
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(input.action === "deny"
      ? { approval: { ...base, id: input.id, status: "denied" } }
      : input.before
        ? { approvals: [{ ...base, id: "approval-old" }] }
        : { approvals: Array.from({ length: 100 }, (_, index) => ({ ...base, id: `approval-${index}` })), nextCursor: "approval-99" }))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected a local test listener")
    await writeFile(join(root, "vite.config.mjs"), `import { createConnectionsCliContributor } from ${JSON.stringify(new URL("../src/cli.ts", import.meta.url).href)}
export default { plugins: [{ name: "connections-cli-test", vitehub: { cli: createConnectionsCliContributor() } }] }
`)
    const bin = fileURLToPath(new URL("../../vite-hub/dist/bin.js", import.meta.url))
    const run = (args: string[]) => new Promise<{ status: number, stdout: string, stderr: string }>(resolve => {
      execFile(process.execPath, [bin, "connections", "approvals", ...args, "--url", `http://127.0.0.1:${address.port}`], { cwd: root }, (error, stdout, stderr) => {
        resolve({ status: error ? Number(error.code) : 0, stdout, stderr })
      })
    })
    const first = await run(["--name", "mail", "--json"])
    expect(first.status, first.stderr).toBe(0)
    expect(first.stderr).toBe("")
    const page = JSON.parse(first.stdout) as { approvals: unknown[], nextCursor: string }
    expect(page.approvals).toHaveLength(100)
    expect(page.nextCursor).toBe("approval-99")
    const second = await run(["--name", "mail", "--before", page.nextCursor, "--json"])
    expect(second.status).toBe(0)
    expect(second.stderr).toBe("")
    expect(JSON.parse(second.stdout)).toEqual({ approvals: [{ ...base, id: "approval-old" }] })
    expect(requests).toContainEqual({ action: "approvals", before: "approval-99", name: "mail", status: "pending" })
    const denied = await run(["deny", "approval-old", "--json"])
    expect(denied.status).toBe(0)
    expect(JSON.parse(denied.stdout)).toMatchObject({ approval: { id: "approval-old", status: "denied" } })
    const invalid = await run(["--before"])
    expect(invalid.status).toBe(1)
    expect(invalid.stdout).toBe("")
    expect(invalid.stderr).toContain("Missing value for --before.")
  }
  finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
