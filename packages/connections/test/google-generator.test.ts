import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { expect, it } from "vitest"

it("generates required document fields, nested fields, and method parameters of the typed Gmail resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-google-generator-"))
  try {
    await mkdir(join(root, "scripts"))
    await mkdir(join(root, "src", "google"), { recursive: true })
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir")
    const document = {
      name: "gmail",
      revision: "fixture",
      rootUrl: "https://gmail.example/",
      title: "Gmail fixture",
      version: "v1",
      schemas: {
        Request: {
          id: "Request",
          type: "object",
          properties: {
            fieldId: { required: true, type: "string" },
            labelId: { description: "Required. The label ID.", type: "string" },
            selection: { type: "string" },
            explicitOptional: { description: "Required. Historical description.", required: false, type: "string" },
            nested: { type: "object", properties: { value: { required: true, type: "number" }, optional: { type: "boolean" } } },
          },
        },
        ImapSettings: { id: "ImapSettings", type: "object", properties: { enabled: { type: "boolean" } } },
        Unused: { id: "Unused", type: "object", properties: { value: { type: "string" } } },
      },
      methods: {
        get: { httpMethod: "GET", id: "gmail.users.messages.get", path: "users/{userId}/messages/{id}" },
        getImap: { httpMethod: "GET", id: "gmail.users.settings.getImap", path: "users/{userId}/settings/imap", response: { $ref: "ImapSettings" } },
        send: {
          httpMethod: "POST",
          id: "gmail.users.messages.send",
          path: "users/{userId}/messages",
          parameters: {
            userId: { location: "path", required: true, type: "string" },
            trace: { location: "query", type: "string" },
            startHistoryId: { location: "query", description: "Required. The history start ID.", type: "string" },
          },
          request: { $ref: "Request" },
        },
      },
    }
    const script = await readFile(new URL("../scripts/generate-google.ts", import.meta.url), "utf8")
    const scriptPath = join(root, "scripts", "generate-google.ts")
    await writeFile(scriptPath, `globalThis.fetch = async () => Response.json(${JSON.stringify(document)})\n${script}`)
    await promisify(execFile)(process.execPath, [scriptPath, "gmail", "v1"], { timeout: 30_000 })
    const output = await readFile(join(root, "src", "google", "gmail.ts"), "utf8")
    expect(output).toContain("fieldId: string")
    expect(output).toContain("labelId: string")
    expect(output).toContain("selection?: string")
    expect(output).toContain("explicitOptional?: string")
    expect(output).toContain("value: number")
    expect(output).toContain("optional?: boolean")
    expect(output).toContain("userId: string")
    expect(output).toContain("trace?: string")
    expect(output).toContain("startHistoryId: string")
    expect(output).toContain("body: GmailRequest")
    expect(output).toContain('"users.messages.get": {\n    method: "GET"')
    expect(output).toContain('"users.messages.send": {\n    method: "POST"')
    // Gmail types only the allowed resources and the schemas they reach. `fetch()` reaches the rest.
    expect(output).not.toContain("users.settings.getImap")
    expect(output).not.toContain("GmailImapSettings")
    expect(output).not.toContain("GmailUnused")
    // Discovery returns properties in any order. The output sorts them.
    expect(output.indexOf("explicitOptional?: string")).toBeLessThan(output.indexOf("fieldId: string"))
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
