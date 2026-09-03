import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspectAgentTools } from "@vite-hub/agent";
import { blob, db, email, gmail, kv, papercuts, sandbox } from "@vite-hub/agent/capabilities";
import type { AgentCapabilityDefinition, AgentToolInspection } from "@vite-hub/agent";

export interface CapabilityReference {
  tools: AgentToolInspection[];
}

export type CapabilityReferences = Record<string, CapabilityReference>;

async function resolveReference(
  capability: AgentCapabilityDefinition,
  context: Record<string, unknown> = {},
): Promise<CapabilityReference> {
  const tools =
    capability.tools instanceof Function
      // SAFETY: Documentation fixtures supply the exact Capability fields read by each resolver.
      ? await capability.tools(context as never)
      : await capability.tools;
  return { tools: inspectAgentTools(tools) || [] };
}

export async function createCapabilityReferences(): Promise<CapabilityReferences> {
  const dbPrimitive = { exec() {}, query() {}, schema: {} };
  const kvPrimitive = { del() {}, get() {}, keys() {}, set() {} };
  const emailPrimitive = { send() {} };
  const sandboxPrimitive = { exec() {} };
  const emailOptions = {
    from: "support@example.com",
    policy: "require-approval" as const,
    recipients: ["customer@example.net", "owner@example.com"],
  };

  return Object.fromEntries(
    await Promise.all([
      ["blob.read", await resolveReference(blob())],
      ["blob.write", await resolveReference(blob({ mode: "write" }))],
      ["db.read", await resolveReference(db(), { capabilities: { db: dbPrimitive } })],
      [
        "db.write",
        await resolveReference(db({ mode: "write", schemaMode: "write" }), {
          capabilities: { db: dbPrimitive },
        }),
      ],
      [
        "email.default",
        await resolveReference(email(emailOptions), { capabilities: { email: emailPrimitive } }),
      ],
      ["gmail.read", await resolveReference(gmail())],
      ["gmail.draft", await resolveReference(gmail({ mode: "draft" }))],
      ["kv.read", await resolveReference(kv(), { capabilities: { kv: kvPrimitive } })],
      [
        "kv.write",
        await resolveReference(kv({ mode: "write" }), { capabilities: { kv: kvPrimitive } }),
      ],
      ["papercuts.default", await resolveReference(papercuts({ report() {} }))],
      [
        "sandbox.default",
        await resolveReference(sandbox({ commands: ["node", "pnpm"] }), {
          capabilities: { sandbox: sandboxPrimitive },
        }),
      ],
    ]),
  );
}

export function writeCapabilityReferences(outputDir: string, references: CapabilityReferences) {
  mkdirSync(outputDir, { recursive: true });
  const source = `export const capabilityReferences = ${JSON.stringify(references, null, 2)};\n\nexport default capabilityReferences;\n`;
  const path = resolve(outputDir, "capability-references.mjs");
  if (existsSync(path) && readFileSync(path, "utf8") === source) return path;
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, source);
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return path;
}
