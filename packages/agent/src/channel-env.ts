import { readBuiltInEnv } from "./internal/builtin-env.ts"

import type { BuiltInEnvField } from "./internal/builtin-env.ts"
import type { CodeHostKind } from "./internal/code-host.ts"
import type { AgentCallbackContext, AgentRuntimeConfig } from "./types.ts"

/** One Server Env value that a built-in Channel reads when its options omit the value. */
export type ChannelEnvField = BuiltInEnvField

/** Server Env of each Code Host. Channels and codeHost() read the same names. */
export const builtInCodeHostEnv = {
  github: {
    appId: { names: ["GITHUB_APP_ID"] },
    appInstallationId: { names: ["GITHUB_APP_INSTALLATION_ID"] },
    appOwner: { names: ["GITHUB_APP_OWNER"] },
    appInstallations: { names: ["GITHUB_APP_INSTALLATIONS"] },
    appPrivateKey: { names: ["GITHUB_APP_PRIVATE_KEY"], secret: true },
    appPrivateKeyPath: { names: ["GITHUB_APP_PRIVATE_KEY_PATH"] },
    token: { names: ["VITEHUB_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"], secret: true },
    webhookSecret: { names: ["GITHUB_WEBHOOK_SECRET"], secret: true },
  },
  gitlab: {
    baseUrl: { names: ["GITLAB_BASE_URL"] },
    token: { names: ["GITLAB_TOKEN"], secret: true },
    webhookSecret: { names: ["GITLAB_WEBHOOK_SECRET"], secret: true },
  },
  forgejo: {
    baseUrl: { names: ["FORGEJO_BASE_URL"] },
    token: { names: ["FORGEJO_TOKEN"], secret: true },
    webhookSecret: { names: ["FORGEJO_WEBHOOK_SECRET"], secret: true },
  },
} as const satisfies Record<CodeHostKind, Record<string, ChannelEnvField>>

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
  github: builtInCodeHostEnv.github,
  gitlab: builtInCodeHostEnv.gitlab,
  forgejo: builtInCodeHostEnv.forgejo,
  telegram: {
    apiBaseUrl: { names: ["TELEGRAM_API_BASE_URL"] },
    botToken: { names: ["TELEGRAM_BOT_TOKEN"], requiredUnless: ["adapter", "botToken"], secret: true },
    webhookSecret: { names: ["TELEGRAM_WEBHOOK_SECRET_TOKEN"], secret: true },
  },
} as const satisfies Record<string, Record<string, ChannelEnvField>>

export type BuiltInChannelEnv = typeof builtInChannelEnv

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
