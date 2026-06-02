import { parseStandardSchema } from "@vite-hub/internal/http-request"

import type { AgentChatRunContext } from "./chat-trigger.ts"
import type {
  AgentCapabilityRuntimeContext,
  AgentInvocationContextStore,
  AgentRunInput,
  AgentRuntimeConfig,
  MaybePromise,
} from "./types.ts"
import type { WorkspaceName } from "@vite-hub/workspace"

export interface AgentInvocationProfileStandardSchemaResultSuccess<T = unknown> {
  issues?: undefined
  value: T
}

export interface AgentInvocationProfileStandardSchemaResultFailure {
  issues: readonly unknown[]
}

export interface AgentInvocationProfileStandardSchemaV1<T = unknown> {
  "~standard": {
    validate: (input: unknown) => AgentInvocationProfileStandardSchemaResultSuccess<T> | AgentInvocationProfileStandardSchemaResultFailure | Promise<AgentInvocationProfileStandardSchemaResultSuccess<T> | AgentInvocationProfileStandardSchemaResultFailure>
  }
}

type ProfileObjectSchema = AgentInvocationProfileStandardSchemaV1<object>

export interface AgentInvocationProfileChatMessageInputSchemaOptions<
  TMessageMetadataSchema extends ProfileObjectSchema | undefined = ProfileObjectSchema | undefined,
  TOrigin extends string = string,
> {
  metadata?: TMessageMetadataSchema
  runOrigin?: readonly TOrigin[]
}

export interface AgentInvocationProfileChatRunInputOptions<TOrigin extends string = string> {
  origin?: readonly TOrigin[]
}

export interface AgentInvocationProfileChatInputSchemaOptions<
  TMessageMetadataSchema extends ProfileObjectSchema | undefined = ProfileObjectSchema | undefined,
  TUserSchema extends ProfileObjectSchema | undefined = ProfileObjectSchema | undefined,
  TOrigin extends string = string,
> {
  message?: AgentInvocationProfileChatMessageInputSchemaOptions<TMessageMetadataSchema, TOrigin>
  run?: AgentInvocationProfileChatRunInputOptions<TOrigin>
  user?: TUserSchema
}

export interface AgentInvocationProfileInputSchemaOptions<
  TMessageMetadataSchema extends ProfileObjectSchema | undefined = ProfileObjectSchema | undefined,
  TUserSchema extends ProfileObjectSchema | undefined = ProfileObjectSchema | undefined,
  TOrigin extends string = string,
> {
  chat?: AgentInvocationProfileChatInputSchemaOptions<TMessageMetadataSchema, TUserSchema, TOrigin>
}

type ProfileSchemaObjectOutput<TSchema> =
  TSchema extends AgentInvocationProfileStandardSchemaV1<infer TOutput>
    ? TOutput extends object ? TOutput : Record<string, unknown>
    : Record<string, unknown>

type ProfileChatRunOrigin<TChat> =
  TChat extends { run?: { origin?: readonly (infer TOrigin)[] } }
    ? Extract<TOrigin, string>
    : string

export type AgentInvocationProfileInputContextFromSchemas<TInputSchemas> =
  TInputSchemas extends { chat?: infer TChat }
    ? AgentChatRunContext<
        TChat extends { message?: { metadata?: infer TMessageMetadataSchema } }
          ? ProfileSchemaObjectOutput<TMessageMetadataSchema>
          : Record<string, unknown>,
        TChat extends { user?: infer TUserSchema }
          ? ProfileSchemaObjectOutput<TUserSchema>
          : Record<string, unknown>,
        ProfileChatRunOrigin<TChat>
      >
    : Record<string, unknown>

export interface AgentInvocationProfileInfer<
  TProfile,
  TInputContext extends object = Record<string, unknown>,
> {
  InputContext: TInputContext
  Profile: TProfile
  RunInput: AgentRunInput<unknown, TInputContext>
}

export type AgentInvocationProfileInputContext<
  TDefinition extends AgentInvocationProfileDefinition<any, any, any, any>,
> =
  TDefinition extends AgentInvocationProfileDefinition<any, any, any, infer TInputContext>
    ? TInputContext
    : Record<string, unknown>

export type AgentInvocationProfileRunInput<
  TDefinition extends AgentInvocationProfileDefinition<any, any, any, any>,
  CALL_OPTIONS = unknown,
> = AgentRunInput<CALL_OPTIONS, AgentInvocationProfileInputContext<TDefinition>>

export type AgentInvocationProfileRunInputFromSchemas<
  TInputSchemas extends AgentInvocationProfileInputSchemaOptions,
  CALL_OPTIONS = unknown,
> = AgentRunInput<CALL_OPTIONS, AgentInvocationProfileInputContextFromSchemas<TInputSchemas>>

export type AgentInvocationProfileContextValueId<TId extends string = string> = `invocationProfile.${TId}`

export type AgentInvocationProfileResolverContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  TInputContext extends object = Record<string, unknown>,
> = Omit<AgentCapabilityRuntimeContext<TRuntimeConfig, Name>, "input"> & {
  input: Omit<AgentCapabilityRuntimeContext<TRuntimeConfig, Name>["input"], "get"> & {
    get: () => AgentRunInput<unknown, TInputContext>
  }
}

export type AgentInvocationProfileResolver<
  TProfile,
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  TInputContext extends object = Record<string, unknown>,
> = (
  context: AgentInvocationProfileResolverContext<TRuntimeConfig, Name, TInputContext>,
) => MaybePromise<TProfile>

export interface AgentInvocationProfileDefinition<
  TProfile = unknown,
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  TInputContext extends object = Record<string, unknown>,
> {
  id: string
  input?: AgentInvocationProfileInputSchemaOptions
  resolve: AgentInvocationProfileResolver<TProfile, TRuntimeConfig, Name, TInputContext>
}

export type DefinedAgentInvocationProfile<
  TProfile = unknown,
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  TInputContext extends object = Record<string, unknown>,
> = AgentInvocationProfileDefinition<TProfile, TRuntimeConfig, Name, TInputContext> & {
  readonly $Infer: AgentInvocationProfileInfer<TProfile, TInputContext>
}

export interface AgentInvocationProfileOptions<
  TProfile,
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  TInputSchemas extends AgentInvocationProfileInputSchemaOptions | undefined = undefined,
  TInputContext extends object = TInputSchemas extends AgentInvocationProfileInputSchemaOptions ? AgentInvocationProfileInputContextFromSchemas<TInputSchemas> : Record<string, unknown>,
> {
  id: string
  input?: TInputSchemas
  resolve: AgentInvocationProfileResolver<TProfile, TRuntimeConfig, Name, TInputContext>
}

const resolvedProfiles = new WeakMap<AgentInvocationContextStore, WeakMap<object, unknown>>()

function assertInvocationProfileId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !id.trim()) {
    throw new TypeError("[vitehub] defineInvocationProfile() requires a non-empty string id.")
  }
  if (!/^[a-z][a-z0-9-_.]*$/i.test(id)) {
    throw new TypeError(`[vitehub] Invocation Profile id "${id}" must be a stable identifier.`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function shouldValidateChatMessageMetadata(
  schemas: AgentInvocationProfileChatMessageInputSchemaOptions,
  chat: Record<string, unknown>,
): boolean {
  const runOrigins = schemas.runOrigin
  if (!runOrigins?.length) return true
  const run = isRecord(chat.run) ? chat.run : undefined
  const origin = run?.origin
  return typeof origin === "string" && runOrigins.includes(origin)
}

export async function applyInvocationProfileInputSchemas(
  schemas: AgentInvocationProfileInputSchemaOptions | undefined,
  input: AgentRunInput,
): Promise<AgentRunInput> {
  const chatSchemas = schemas?.chat
  if (!chatSchemas) return input

  const inputContext = isRecord(input.context) ? input.context : undefined
  const chat = isRecord(inputContext?.chat) ? inputContext.chat : {}

  let nextChat = chat
  const message = isRecord(chat.message) ? chat.message : undefined
  const messageSchemas = chatSchemas.message
  const metadataSchema = messageSchemas?.metadata
  if (messageSchemas && metadataSchema && shouldValidateChatMessageMetadata(messageSchemas, chat)) {
    const metadata = await parseStandardSchema(metadataSchema, message?.metadata, "chat.message.metadata")
    nextChat = {
      ...nextChat,
      message: {
        ...(message || {}),
        metadata,
      },
    }
  }

  const userSchema = chatSchemas.user
  if (userSchema) {
    const user = await parseStandardSchema(userSchema, chat.user, "chat.user")
    nextChat = {
      ...nextChat,
      user,
    }
  }

  const origins = chatSchemas.run?.origin
  if (origins) {
    const run = isRecord(chat.run) ? chat.run : undefined
    const origin = run?.origin
    if (typeof origin !== "string" || !origins.includes(origin)) {
      throw new Error(`[vitehub] Invalid chat.run.origin: expected one of ${origins.map(value => JSON.stringify(value)).join(", ")}.`)
    }
  }

  if (nextChat === chat) return input
  return {
    ...input,
    context: {
      ...(inputContext || {}),
      chat: nextChat,
    },
  }
}

export function defineInvocationProfile<
  TProfile,
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  const TInputSchemas extends AgentInvocationProfileInputSchemaOptions | undefined = undefined,
>(
  options: AgentInvocationProfileOptions<TProfile, TRuntimeConfig, Name, TInputSchemas>,
): DefinedAgentInvocationProfile<
  TProfile,
  TRuntimeConfig,
  Name,
  TInputSchemas extends AgentInvocationProfileInputSchemaOptions ? AgentInvocationProfileInputContextFromSchemas<TInputSchemas> : Record<string, unknown>
> {
  if (!options || typeof options !== "object") {
    throw new TypeError("[vitehub] defineInvocationProfile() requires options.")
  }
  assertInvocationProfileId(options.id)
  if (typeof options.resolve !== "function") {
    throw new TypeError("[vitehub] defineInvocationProfile() requires a resolve callback.")
  }
  return options as never
}

export async function resolveInvocationProfile<
  TProfile,
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
  TInputContext extends object,
>(
  definition: AgentInvocationProfileDefinition<TProfile, TRuntimeConfig, Name, TInputContext>,
  context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>,
): Promise<TProfile> {
  let cache = resolvedProfiles.get(context.context)
  if (!cache) {
    cache = new WeakMap()
    resolvedProfiles.set(context.context, cache)
  }
  if (cache.has(definition)) return cache.get(definition) as TProfile

  const input = await applyInvocationProfileInputSchemas(definition.input, context.input.get())
  if (input !== context.input.get()) context.input.set(input)

  const profile = await definition.resolve(context as AgentInvocationProfileResolverContext<TRuntimeConfig, Name, TInputContext>)
  const contextId: AgentInvocationProfileContextValueId = `invocationProfile.${definition.id}`
  context.context.set(contextId, profile)
  cache.set(definition, profile)
  return profile
}
