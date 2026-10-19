import * as v from "valibot"

import { isSafeEndpoint, isValidApiKeyProvider } from "./api-key.ts"
import { ConnectionError } from "./errors.ts"
import { isValidLoginProvider } from "./oauth-login.ts"
import type { ConnectionApiSelection, ConnectionDefinition, ConnectionInstancesDefinition } from "./types.ts"

const connectionValue = v.union([v.string(), v.function()])
const accessRuleSchema = v.union([
  v.literal("mcp"),
  v.pipe(v.unknown(), v.check(value => !Array.isArray(value)), v.object({
    read: v.optional(v.boolean()),
    write: v.optional(v.union([v.boolean(), v.literal("approve"), v.array(v.string())])),
    approve: v.optional(v.boolean()),
  })),
])
const apiCatalogsSchema = v.record(v.string(), v.object({
  rootUrl: v.string(),
  methods: v.record(v.string(), v.tuple([v.string(), v.string(), v.boolean()])),
  highRisk: v.optional(v.array(v.string())),
}))
const mcpSchema = v.optional(v.pipe(v.string(), v.check(isSafeEndpoint)))
const delaySchema = v.pipe(v.number(), v.finite(), v.minValue(0))
const spanSchema = v.pipe(v.number(), v.finite(), v.gtValue(0))
const requestsSchema = v.optional(v.strictObject({
  bucket: v.optional(v.pipe(v.string(), v.minLength(1))),
  rate: v.optional(v.union([
    v.strictObject({ intervalMs: spanSchema }),
    v.strictObject({ limit: v.pipe(v.number(), v.integer(), v.minValue(1)), perMs: spanSchema }),
  ])),
  retry: v.optional(v.strictObject({
    attempts: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    methods: v.optional(v.array(v.pipe(v.string(), v.regex(/^[A-Za-z]+$/)))),
    delayMs: v.optional(delaySchema),
    on429: v.optional(v.strictObject({ minDelayMs: v.optional(delaySchema) })),
  })),
  timeoutMs: v.optional(spanSchema),
}))
const rulesSchema = {
  api: v.optional(v.pipe(v.unknown(), v.check(value => !Array.isArray(value)), v.record(v.string(), v.optional(v.array(v.string()))))),
  access: v.optional(v.pipe(v.unknown(), v.check(value => !Array.isArray(value)), v.record(v.string(), accessRuleSchema))),
}
const oauthDefinitionSchema = v.looseObject({
  provider: v.looseObject({
    id: v.string(),
    authorizationEndpoint: v.string(),
    tokenEndpoint: v.string(),
    clientId: connectionValue,
    clientSecret: v.optional(connectionValue),
    account: v.optional(v.function()),
    apis: v.optional(apiCatalogsSchema),
    mcp: mcpSchema,
    requests: requestsSchema,
  }),
  scopes: v.array(v.string()),
  ...rulesSchema,
})
const apiKeyDefinitionSchema = v.looseObject({
  provider: v.pipe(
    v.nonNullish(v.unknown()),
    v.check(provider => Object.prototype.hasOwnProperty.call(provider, "kind")),
    v.looseObject({
      kind: v.literal("api-key"),
      id: v.pipe(v.string(), v.regex(/^\S+$/)),
      header: v.string(),
      scheme: v.optional(v.string()),
      origins: v.array(v.string()),
      apis: apiCatalogsSchema,
      mcp: mcpSchema,
      requests: requestsSchema,
      fallback: v.optional(v.function()),
      verify: v.optional(v.function()),
    }),
    v.check(provider => isValidApiKeyProvider(provider)),
  ),
  scopes: v.optional(v.undefined()),
  ...rulesSchema,
})
const loginDefinitionSchema = v.looseObject({
  provider: v.pipe(
    v.nonNullish(v.unknown()),
    v.check(provider => Object.prototype.hasOwnProperty.call(provider, "kind")),
    v.looseObject({
      kind: v.literal("oauth-login"),
      id: v.pipe(v.string(), v.regex(/^\S+$/)),
      login: v.function(),
      origins: v.array(v.string()),
      redirectUri: v.string(),
      issuer: mcpSchema,
      resource: mcpSchema,
      apis: v.optional(apiCatalogsSchema),
      clientId: v.optional(connectionValue),
      clientName: v.optional(v.string()),
      credentials: v.optional(v.function()),
      account: v.optional(v.function()),
      mcp: mcpSchema,
      requests: requestsSchema,
    }),
    v.check(provider => isValidLoginProvider(provider)),
  ),
  scopes: v.optional(v.array(v.string())),
  ...rulesSchema,
})
const definitionSchema = v.pipe(
  v.union([oauthDefinitionSchema, apiKeyDefinitionSchema, loginDefinitionSchema]),
  // The `"mcp"` preset allows only the provider's `mcp` endpoint, so a provider without one would deny every call.
  v.check(definition => definition.provider.mcp !== undefined || !Object.values(definition.access ?? {}).includes("mcp")),
)
const instancesSchema = v.strictObject({
  instances: v.pipe(
    v.array(v.pipe(v.string(), v.regex(/^[\w.-]{1,128}$/))),
    v.check(instances => new Set(instances).size === instances.length),
  ),
  definition: v.function(),
})

/** Validate discovered and directly declared Connections with the same contract. */
export function isConnectionDefinition(value: unknown): value is ConnectionDefinition {
  return v.is(definitionSchema, value)
}

/** Whether a value is a keyed Connection Definition with `instances`. */
export function isConnectionInstances(value: unknown): value is ConnectionInstancesDefinition {
  return v.is(instancesSchema, value)
}

/**
 * Define a Connection. The file name under `server/connections/` is the Connection name.
 *
 * With `instances`, define one Connection per instance, for example one per tenant: each instance
 * is a Connection named `<name>:<instance>`, and `definition(instance)` returns its definition.
 */
export function defineConnection<
  const TApis extends object,
  const TSelection extends ConnectionApiSelection<TApis> = ConnectionApiSelection<TApis>,
  const TInstance extends string = never,
  const TDefinition extends ConnectionDefinition = never,
>(definition: ConnectionDefinition<TApis, TSelection> | ConnectionInstancesDefinition<TInstance, TDefinition>): [TInstance] extends [never]
  ? ConnectionDefinition<TApis, TSelection>
  : ConnectionInstancesDefinition<TInstance, TDefinition> {
  if (!isConnectionDefinition(definition) && !isConnectionInstances(definition)) throw new ConnectionError("invalid", "The Connection Definition is invalid.")
  // SAFETY: The validated input is returned unchanged; the conditional type names the member that it matched.
  return definition as [TInstance] extends [never] ? ConnectionDefinition<TApis, TSelection> : ConnectionInstancesDefinition<TInstance, TDefinition>
}
