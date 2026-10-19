import { readBuiltInEnv } from "./internal/builtin-env.ts"

import { forgeEnv, type ForgeEnv } from "@vite-hub/forge"

import type { BuiltInEnvField } from "./internal/builtin-env.ts"
import type { AgentCallbackContext, AgentRuntimeConfig } from "./types.ts"

/** One Server Env value that a built-in Channel reads when its options omit the value. */
export type ChannelEnvField = BuiltInEnvField

/**
 * Server Env declared by built-in Channels, keyed by Channel factory name and then by
 * the `env.server.<channel>.<field>` path.
 *
 * To add Env for a built-in Channel, add its factory name here and read each value with
 * `channelEnvValue()`. ViteHub then finds the factory in Agent files, declares the values
 * in Server Env, shows them in the Console, and adds required secrets to Wrangler.
 */
export type BuiltInChannelEnv = {
  discord: Record<"applicationId" | "botToken" | "publicKey", ChannelEnvField>
  github: ForgeEnv["github"]
  gitlab: ForgeEnv["gitlab"]
  forgejo: ForgeEnv["forgejo"]
  telegram: Record<"apiBaseUrl" | "botToken" | "webhookSecret", ChannelEnvField>
}

export const builtInChannelEnv: BuiltInChannelEnv = {
  discord: {
    applicationId: { names: ["DISCORD_APPLICATION_ID"] },
    botToken: { names: ["DISCORD_BOT_TOKEN"], secret: true },
    publicKey: { names: ["DISCORD_PUBLIC_KEY"], secret: true },
  },
  github: forgeEnv.github,
  gitlab: forgeEnv.gitlab,
  forgejo: forgeEnv.forgejo,
  telegram: {
    apiBaseUrl: { names: ["TELEGRAM_API_BASE_URL"] },
    botToken: { names: ["TELEGRAM_BOT_TOKEN"], requiredUnless: ["adapter", "botToken"], secret: true },
    webhookSecret: { names: ["TELEGRAM_WEBHOOK_SECRET_TOKEN"], secret: true },
  },
}

const channelEnvFields: Readonly<Record<string, Readonly<Record<string, ChannelEnvField>>>> = builtInChannelEnv

async function readChannelEnv<TRuntimeConfig extends AgentRuntimeConfig>(
  channel: string,
  fields: readonly string[],
  context: AgentCallbackContext<TRuntimeConfig>,
): Promise<Partial<Record<string, unknown>>> {
  return await readBuiltInEnv(channel, channelEnvFields[channel] ?? {}, fields, context)
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
