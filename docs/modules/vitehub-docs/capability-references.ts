import { inspectAgentTools } from "@vite-hub/agent";
import { blob, content, db, email, gmail, kv, papercuts, sandbox } from "@vite-hub/agent/capabilities";
import type { AgentCapabilityDefinition, AgentToolInspection } from "@vite-hub/agent";

export interface CapabilityReference {
  tools: AgentToolInspection[];
}

export type CapabilityReferences = Record<string, CapabilityReference>;

function isCallable(value: unknown): value is CallableFunction {
  if (value === null || value === undefined || Object(value) !== value) return false;
  try {
    Function.prototype.toString.call(value);
    return true;
  } catch {
    return false;
  }
}

async function resolveReference(
  capability: AgentCapabilityDefinition,
  context: Record<string, unknown> = {},
): Promise<CapabilityReference> {
  const tools =
    isCallable(capability.tools)
      // SAFETY: Documentation fixtures supply only the minimal runtime primitives required by each known built-in Capability.
      ? await capability.tools(context as never)
      : await capability.tools;
  return { tools: inspectAgentTools(tools) || [] };
}

export async function createCapabilityReferences(): Promise<CapabilityReferences> {
  const dbPrimitive = { exec() {}, query() {}, schema: {} };
  const kvPrimitive = { del() {}, get() {}, keys() {}, set() {} };
  const emailPrimitive = { send() {} };
  const sandboxPrimitive = { exec() {} };
  const connectionsPrimitive = {
    runtime() {
      return {
        client() {
          return {
            call() {
              throw new Error("Documentation references must not execute Connection calls.");
            },
            fetch() {
              throw new Error("Documentation references must not execute Connection fetches.");
            },
          };
        },
      };
    },
  };
  const gmailContext = {
    capabilities: { connections: connectionsPrimitive },
    context: new Map<string, unknown>(),
  };
  const contentPrimitive = {
    can() {
      throw new Error("Documentation references must not evaluate Content access.");
    },
    collections() {
      return [{
        fields: ["title", "date", "tags"],
        format: "markdown",
        kind: "documents",
        label: "Posts",
        name: "posts",
        path: "posts/**/*.md",
        schema: {
          properties: {
            // The schema that `z.coerce.date()` and `z.array(z.string()).default([])` project to.
            date: { format: "date-time", type: "string" },
            tags: { default: [], items: { type: "string" }, type: "array" },
            title: { minLength: 1, type: "string" },
          },
          required: ["title", "date"],
          type: "object",
        },
        titleField: "title",
      }];
    },
    publish() {
      throw new Error("Documentation references must not publish Content.");
    },
    schedule() {
      throw new Error("Documentation references must not schedule Content.");
    },
    schedules() {
      throw new Error("Documentation references must not read Content schedules.");
    },
    unschedule() {
      throw new Error("Documentation references must not cancel Content schedules.");
    },
  };
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
        "content.default",
        await resolveReference(content(), { capabilities: { content: contentPrimitive }, context: new Map<string, unknown>() }),
      ],
      [
        "email.default",
        await resolveReference(email(emailOptions), { capabilities: { email: emailPrimitive } }),
      ],
      [
        "gmail.read",
        await resolveReference(gmail(), gmailContext),
      ],
      [
        "gmail.draft",
        await resolveReference(gmail({ operations: ["search", "read", "draft"] }), gmailContext),
      ],
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

let references: Promise<CapabilityReferences> | undefined;

/** The references, computed once per process. The module and the raw Markdown rewrite share them. */
export function capabilityReferences(): Promise<CapabilityReferences> {
  references ??= createCapabilityReferences();
  return references;
}

function directiveAttribute(attributes: string, name: string) {
  return attributes.match(new RegExp(`\\b${name}=(?:"([^"]+)"|'([^']+)')`))?.slice(1).find(Boolean);
}

function capabilityReferenceMarkdown(attributes: string, references: CapabilityReferences) {
  const name = directiveAttribute(attributes, "name");
  const variant = directiveAttribute(attributes, "variant") || "default";
  const reference = name ? references[`${name}.${variant}`] : undefined;
  if (!reference) return "_Agent-visible tool contract is available on the rendered documentation page._";
  return reference.tools.map(tool => [
    `#### \`${tool.name}\``,
    tool.description || "",
    ...(tool.inputSchema === undefined
      ? []
      : [`**Input schema**\n\n\`\`\`json\n${JSON.stringify(tool.inputSchema, null, 2)}\n\`\`\``]),
    ...(tool.outputSchema === undefined
      ? []
      : [`**Output schema**\n\n\`\`\`json\n${JSON.stringify(tool.outputSchema, null, 2)}\n\`\`\``]),
  ].filter(Boolean).join("\n\n")).join("\n\n");
}

/** Expands `::agent-capability-tools{name="kv" variant="write"}` into the tool contract, for the raw Markdown agents read. */
export function expandCapabilityTools(source: string, references: CapabilityReferences) {
  return source.replace(/^::agent-capability-tools\{([^}]*)\}\s*\n::\s*$/gm, (_match, attributes: string) =>
    capabilityReferenceMarkdown(attributes, references));
}
