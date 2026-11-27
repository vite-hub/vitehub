import * as v from "valibot"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import { defineCapability } from "../capability-runtime.ts"
import { isRuntimeRecord } from "../internal/runtime-type.ts"
import { defineInternalTool, requirePrimitive } from "./internal.ts"

import type { AgentCapabilityContext, AgentCapabilityDefinition, AgentToolPolicyContext, AgentToolPolicyDecision, AgentToolSet, MaybePromise } from "../types.ts"

/** Tool groups: `read` shows coverage and missing messages, `write` saves drafts, `publish` makes drafts live. */
export type I18nCapabilityOperation = "publish" | "read" | "write"

export type I18nCapabilityToolPolicy = AgentToolPolicyDecision | ((context: AgentToolPolicyContext) => MaybePromise<AgentToolPolicyDecision>)

export interface I18nCapabilityOptions {
  /** Tool groups to expose. Default: `["read", "write", "publish"]`. */
  operations?: readonly I18nCapabilityOperation[]
  /**
   * Policy for `i18n_save_translation` and `i18n_publish`. It replaces the defaults: saving drafts is allowed, and
   * publishing requires approval. A function receives `{ name, input }`.
   */
  policy?: I18nCapabilityToolPolicy
}

type Failure = { code: string, message: string, fix?: string }
type Result<T> = readonly [Failure, undefined] | readonly [undefined, T]

/** `useTranslations()` from `vite-hub/i18n/server`, as `agentI18n` passes it. */
interface I18nPrimitive {
  status: () => Promise<unknown>
  missing: (locale: string, options?: { limit?: number, cursor?: string }) => Promise<Result<unknown>>
  save: (input: { locale: string, source: string, context?: string, translation: string, review?: "machine", by?: string }) => Promise<Result<unknown>>
  publish: (options?: { message?: string }) => Promise<unknown>
}

function isI18nPrimitive(value: unknown): value is I18nPrimitive {
  return isRuntimeRecord(value)
    && value.status instanceof Function
    && value.missing instanceof Function
    && value.save instanceof Function
    && value.publish instanceof Function
}

function i18nPrimitive(context: AgentCapabilityContext): I18nPrimitive {
  const handle = requirePrimitive(context, "i18n")
  if (!isI18nPrimitive(handle)) throw agentDiagnostics.AGENT_R0104({ message: "[vitehub] The i18n primitive must be agentI18n from vite-hub/i18n/server." })
  return handle
}

function failed(error: Failure) {
  return { error: { code: error.code, message: error.message, ...(error.fix ? { fix: error.fix } : {}) }, ok: false as const }
}

const operationNames = ["read", "write", "publish"] as const
const policyDecisionSchema = v.picklist(["allow", "deny", "require-approval", "retryable-failure"])
const optionsSchema = v.strictObject({
  operations: v.optional(v.pipe(v.array(v.picklist(operationNames)), v.minLength(1)), [...operationNames]),
  policy: v.optional(v.union([policyDecisionSchema, v.function()])),
})

interface MissingInput { locale: string, limit?: number | null, cursor?: string | null }
interface SaveInput { locale: string, source: string, context: string | null, translation: string }
interface PublishInput { message?: string | null }

function i18nTools(context: AgentCapabilityContext, enabled: ReadonlySet<I18nCapabilityOperation>, policy: I18nCapabilityToolPolicy | undefined): AgentToolSet {
  const i18n = i18nPrimitive(context)
  const writePolicy = (tool: "publish" | "save"): I18nCapabilityToolPolicy => async (policyContext) => {
    const decision = policy ?? (tool === "save" ? "allow" : "require-approval")
    return decision instanceof Function ? await decision(policyContext) : decision
  }
  const tools: AgentToolSet = {}
  if (enabled.has("read")) {
    tools.i18n_status = defineInternalTool<Record<string, never>>({
      description: "Show, for each translated locale, how many messages the code has, how many are published, how many are saved as drafts, and how many have no translation.",
      execute: async () => ({ locales: await i18n.status(), ok: true as const }),
      icon: "i-lucide-languages",
      inputSchema: { additionalProperties: false, properties: {}, type: "object" },
      name: "i18n_status",
      title: "Read translation coverage",
    })
    tools.i18n_list_missing = defineInternalTool<MissingInput>({
      description: "List messages that a locale does not translate yet, with the source text, its context, the places in the code, and the translation of an older version when the text changed a little. Pass the cursor of the last page to read the next one.",
      execute: async (input) => {
        const [error, page] = await i18n.missing(input.locale, {
          ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
        })
        return error ? failed(error) : { ok: true as const, page }
      },
      icon: "i-lucide-list-todo",
      inputSchema: {
        additionalProperties: false,
        properties: {
          cursor: { anyOf: [{ type: "string" }, { type: "null" }], description: "The cursor of the previous page, or null for the first page." },
          limit: { anyOf: [{ maximum: 200, minimum: 1, type: "integer" }, { type: "null" }], description: "Messages per page. Default: 50." },
          locale: { description: "A translated locale from i18n_status, such as \"es\".", type: "string" },
        },
        required: ["cursor", "limit", "locale"],
        type: "object",
      },
      name: "i18n_list_missing",
      title: "Listed missing translations",
    })
  }
  if (enabled.has("write")) {
    tools.i18n_save_translation = defineInternalTool<SaveInput>({
      description: "Save one translation to the draft ref, marked as a machine translation. The site shows it after i18n_publish. Copy source and context exactly from i18n_list_missing. Write ICU MessageFormat, and keep every {placeholder}, plural argument, and <0> tag of the source. A translation that breaks them comes back as ok: false with the reason.",
      execute: async (input) => {
        const [error, saved] = await i18n.save({
          locale: input.locale,
          source: input.source,
          ...(input.context ? { context: input.context } : {}),
          translation: input.translation,
          review: "machine",
          by: context.invoker?.label ?? context.invoker?.id ?? "agent",
        })
        return error ? failed(error) : { ok: true as const, saved }
      },
      icon: "i-lucide-languages",
      inputSchema: {
        additionalProperties: false,
        properties: {
          context: { anyOf: [{ type: "string" }, { type: "null" }], description: "The context of the message, or null when it has none." },
          locale: { description: "The locale of the translation.", type: "string" },
          source: { description: "The source text, exactly as i18n_list_missing returns it.", type: "string" },
          translation: { description: "The translated message.", type: "string" },
        },
        required: ["context", "locale", "source", "translation"],
        type: "object",
      },
      metadata: { i18n: { operation: "save" } },
      name: "i18n_save_translation",
      policy: writePolicy("save"),
      title: "Saved a translation draft",
    })
  }
  if (enabled.has("publish")) {
    tools.i18n_publish = defineInternalTool<PublishInput>({
      description: "Publish every saved translation draft in one revision. The site uses them on the next request, without a deploy.",
      execute: async input => ({ ok: true as const, ...await i18n.publish(input.message ? { message: input.message } : undefined) as object }),
      icon: "i-lucide-send",
      inputSchema: {
        additionalProperties: false,
        properties: { message: { anyOf: [{ type: "string" }, { type: "null" }], description: "A short description of the change, or null." } },
        required: ["message"],
        type: "object",
      },
      metadata: { i18n: { operation: "publish" } },
      name: "i18n_publish",
      policy: writePolicy("publish"),
      title: "Published translations",
    })
  }
  return tools
}

/**
 * Tools to find missing translations, save drafts, and publish them, in the Workspace of `i18n.workspace`. Saving is
 * allowed and publishing requires approval, unless `policy` says otherwise.
 */
export function i18n(options: I18nCapabilityOptions = {}): AgentCapabilityDefinition {
  const parsed = v.safeParse(optionsSchema, options)
  if (!parsed.success) throw agentDiagnostics.AGENT_C0014()
  // SAFETY: The schema checked that policy is a decision or a function.
  const { operations, policy } = parsed.output as typeof parsed.output & Pick<I18nCapabilityOptions, "policy">
  const enabled = new Set<I18nCapabilityOperation>(operations)
  return defineCapability({
    id: "i18n",
    metadata: {
      approval: policy === undefined
        ? (enabled.has("publish") ? ["i18n_publish"] : [])
        : v.is(policyDecisionSchema, policy) ? policy : "custom",
      operations: operationNames.filter(operation => enabled.has(operation)),
    },
    mode: enabled.has("write") || enabled.has("publish") ? "write" : "read",
    requires: [{ primitive: "i18n" }],
    tools: context => i18nTools(context, enabled, policy),
  })
}
