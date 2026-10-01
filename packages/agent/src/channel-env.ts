import { getViteHubErrorShape } from "@vite-hub/runtime"

import { isRuntimeRecord } from "./internal/runtime-type.ts"

import type { AgentCallbackContext, AgentRuntimeConfig } from "./types.ts"

/** One Server Env value that a built-in Channel reads when its options omit the value. */
export interface ChannelEnvField {
  /** Host variable names in lookup order. */
  names: readonly [string, ...string[]]
  secret?: true
  /**
   * The value is required when an Agent uses the Channel without one of these option keys.
   * Omit it to keep the value optional.
   */
  requiredUnless?: readonly string[]
}

/**
 * Server Env declared by built-in Channels, keyed by Channel factory name and then by
 * the `env.server.<channel>.<field>` path.
 *
 * To add Env for a built-in Channel, add its factory name here and read each value with
 * `channelEnvValue()`. ViteHub then finds the factory in Agent files, declares the values
 * in Server Env, shows them in the Console, and adds required secrets to Wrangler.
 */
export const builtInChannelEnv = {
  discord: {
    applicationId: { names: ["DISCORD_APPLICATION_ID"] },
    botToken: { names: ["DISCORD_BOT_TOKEN"], secret: true },
    publicKey: { names: ["DISCORD_PUBLIC_KEY"], secret: true },
  },
  github: {
    appId: { names: ["GITHUB_APP_ID"] },
    appInstallationId: { names: ["GITHUB_APP_INSTALLATION_ID"] },
    appPrivateKey: { names: ["GITHUB_APP_PRIVATE_KEY"], secret: true },
    appPrivateKeyPath: { names: ["GITHUB_APP_PRIVATE_KEY_PATH"] },
    token: { names: ["VITEHUB_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"], secret: true },
    webhookSecret: { names: ["GITHUB_WEBHOOK_SECRET"], secret: true },
  },
  telegram: {
    apiBaseUrl: { names: ["TELEGRAM_API_BASE_URL"] },
    botToken: { names: ["TELEGRAM_BOT_TOKEN"], requiredUnless: ["adapter", "botToken"], secret: true },
    webhookSecret: { names: ["TELEGRAM_WEBHOOK_SECRET_TOKEN"], secret: true },
  },
} as const satisfies Record<string, Record<string, ChannelEnvField>>

export type BuiltInChannelEnv = typeof builtInChannelEnv

const channelEnvFields: Readonly<Record<string, Readonly<Record<string, ChannelEnvField>>>> = builtInChannelEnv

const serverEnvModuleId = "#vitehub/env/server"

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return isRuntimeRecord(value) && !Array.isArray(value)
}

interface ServerEnvModule {
  loadServerEnv?: (event?: unknown) => Promise<unknown>
  useServerEnv?: (event?: unknown) => unknown
}

let serverEnvModule: Promise<ServerEnvModule | undefined> | undefined

// Without hubEnv() the generated module does not resolve. Other import failures, such as a
// provider module that throws while it loads, are configuration errors and stay visible.
function isMissingModule(error: unknown): boolean {
  const code = isRecord(error) ? error.code : undefined
  const message = error instanceof Error ? error.message : ""
  if (code === "ERR_MODULE_NOT_FOUND") return /^Cannot find (?:package|module) ['"]#vitehub\/env\/server['"]/.test(message)
  if (code === "ERR_PACKAGE_IMPORT_NOT_DEFINED") return /^Package import specifier ["']#vitehub\/env\/server["'] is not defined/.test(message)
  return /(?:cannot find (?:package|module)|failed to (?:resolve|load)(?: (?:module|url))?|no such module|missing (?:module|package))\s+(?:["']#vitehub\/env\/server["']|#vitehub\/env\/server(?=\s|\(|$))/i.test(message)
}

function importServerEnvModule(): Promise<ServerEnvModule | undefined> {
  // hubEnv() rewrites the tagged import so Vite can resolve its generated module.
  // SAFETY: The generated server env module exposes the optional useServerEnv and loadServerEnv entrypoints.
  serverEnvModule ??= (import(/* @vite-ignore */ /* @vitehub-env */ serverEnvModuleId) as Promise<ServerEnvModule>)
    .catch((error: unknown) => {
      if (isMissingModule(error)) return undefined
      throw error
    })
  return serverEnvModule
}

function channelGroup(env: unknown, channel: string): Record<PropertyKey, unknown> | undefined {
  const group = isRecord(env) ? env[channel] : undefined
  return isRecord(group) ? group : undefined
}

async function readChannelEnv<TRuntimeConfig extends AgentRuntimeConfig>(
  channel: string,
  fields: readonly string[],
  context: AgentCallbackContext<TRuntimeConfig>,
): Promise<Partial<Record<string, unknown>>> {
  const cloudflareEnv = context.cloudflare?.env
  const event = cloudflareEnv ? { env: cloudflareEnv } : undefined
  const module = await importServerEnvModule()
  // Resolution errors, such as a missing required value, are configuration errors and stay visible.
  const group = module?.useServerEnv ? channelGroup(module.useServerEnv(event), channel) : undefined
  let loaded: Promise<Record<PropertyKey, unknown> | undefined> | undefined
  const values: Partial<Record<string, unknown>> = {}
  for (const field of fields) {
    if (group && Object.hasOwn(group, field)) {
      try {
        values[field] = group[field]
      }
      catch (error) {
        // Provider-backed values need the asynchronous snapshot.
        if (getViteHubErrorShape(error)?.code !== "ENV_ASYNC_REQUIRED" || !module?.loadServerEnv) throw error
        const loadServerEnv = module.loadServerEnv
        loaded ??= loadServerEnv(event).then(env => channelGroup(env, channel))
        values[field] = (await loaded)?.[field]
      }
      continue
    }
    // An empty host variable counts as unset, so the next name can supply the value.
    values[field] = (channelEnvFields[channel]?.[field]?.names ?? [])
      .map(name => cloudflareEnv?.[name] ?? globalThis.process?.env?.[name])
      .find(value => value !== undefined && value !== "")
  }
  return values
}

/**
 * Read every field of `env.server.<channel>`. A field that Server Env declares is read only
 * from Server Env, including provider-backed values. A field that it does not declare, for
 * example without hubEnv(), is read from its host variable names.
 * Explicit Channel options take precedence; callers read Env only when an option is omitted.
 */
export async function channelEnv<
  TChannel extends keyof BuiltInChannelEnv,
  TRuntimeConfig extends AgentRuntimeConfig,
>(
  channel: TChannel,
  context: AgentCallbackContext<TRuntimeConfig>,
): Promise<Partial<Record<keyof BuiltInChannelEnv[TChannel] & string, unknown>>> {
  return await readChannelEnv(channel, Object.keys(builtInChannelEnv[channel]), context)
}

/** Read one field of `env.server.<channel>` with the rules of `channelEnv()`. */
export async function channelEnvValue<
  TChannel extends keyof BuiltInChannelEnv,
  TRuntimeConfig extends AgentRuntimeConfig,
>(
  channel: TChannel,
  field: keyof BuiltInChannelEnv[TChannel] & string,
  context: AgentCallbackContext<TRuntimeConfig>,
): Promise<unknown> {
  return (await readChannelEnv(channel, [field], context))[field]
}
