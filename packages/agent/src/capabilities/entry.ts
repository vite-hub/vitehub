import { defineCapability } from "../capability-runtime.ts"

import type { AgentChatCapabilityOrigin } from "../chat-trigger.ts"
import type {
  AgentCapabilityDefinition,
  AgentCapabilityTypeContract,
  AgentRuntimeConfig,
  AgentTriggerDefinition,
} from "../types.ts"
import type { WorkspaceName } from "@vite-hub/workspace"

export interface AgentEntryChatOptions<TOrigin extends string = string, TChatCapability = unknown> {
  capability?: TChatCapability
  origin?: TOrigin
}

export type AgentEntryChatExposure<TOrigin extends string = string, TChatCapability = unknown> =
  | boolean
  | TOrigin
  | AgentEntryChatOptions<TOrigin, TChatCapability>

export interface AgentEntryOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  TChat extends AgentEntryChatExposure | undefined = AgentEntryChatExposure | undefined,
> {
  chat?: TChat
  id: string
  triggers?: Record<string, AgentTriggerDefinition<TRuntimeConfig, Name, any, any>>
}

export interface AgentEntryCapabilityMetadata {
  entry: {
    chat?: AgentEntryChatOptions
    id: string
  }
  kind: "entry"
}

type AgentEntryChatOwnOrigin<TChat> =
  TChat extends string
    ? TChat
    : TChat extends true
      ? "http"
      : TChat extends { origin?: infer TOrigin }
        ? [Extract<TOrigin, string>] extends [never] ? "http" : Extract<TOrigin, string>
        : never

type AgentEntryChatLinkedOrigin<TChat> =
  TChat extends { capability?: infer TCapability }
    ? AgentChatCapabilityOrigin<TCapability>
    : never

type AgentEntryChatOrigin<TChat> = AgentEntryChatOwnOrigin<TChat> | AgentEntryChatLinkedOrigin<TChat>

export type AgentEntryOptionsOrigin<TOptions> =
  TOptions extends { chat?: infer TChat }
    ? [AgentEntryChatOrigin<TChat>] extends [never] ? string : AgentEntryChatOrigin<TChat>
    : string

type EntryCapabilityTypeContract<TOrigin extends string = string> = AgentCapabilityTypeContract & {
  chatOrigins: TOrigin
}

export function normalizeEntryChatOptions(chat: AgentEntryChatExposure | undefined): AgentEntryChatOptions | undefined {
  if (!chat) return undefined
  if (typeof chat === "string") return { origin: chat }
  if (chat === true) return { origin: "http" }
  return {
    ...chat,
    origin: chat.origin || "http",
  }
}

function entryMetadata(capability: AgentCapabilityDefinition): AgentEntryCapabilityMetadata | undefined {
  const metadata = capability.metadata as AgentEntryCapabilityMetadata | undefined
  return metadata?.kind === "entry" ? metadata : undefined
}

export function getEntryChatOptions(capabilities: AgentCapabilityDefinition[]): AgentEntryChatOptions | undefined {
  const entries = capabilities
    .map(entryMetadata)
    .filter((metadata): metadata is AgentEntryCapabilityMetadata => Boolean(metadata?.entry.chat))
  if (entries.length > 1) {
    throw new Error("[vitehub] Only one entry({ chat }) capability can expose the generated Chat App Route for an Agent.")
  }
  return entries[0]?.entry.chat
}

export function entry<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  const TOptions extends AgentEntryOptions<TRuntimeConfig, Name> = AgentEntryOptions<TRuntimeConfig, Name>,
>(
  options: TOptions,
): AgentCapabilityDefinition<TRuntimeConfig, Name, EntryCapabilityTypeContract<AgentEntryOptionsOrigin<TOptions>>> {
  const chat = normalizeEntryChatOptions(options.chat)
  return defineCapability({
    id: options.id,
    metadata: {
      entry: {
        ...(chat ? { chat } : {}),
        id: options.id,
      },
      kind: "entry",
    } satisfies AgentEntryCapabilityMetadata,
    triggers: options.triggers,
  })
}
