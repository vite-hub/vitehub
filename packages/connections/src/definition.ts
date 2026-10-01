import * as v from "valibot"

import { ConnectionError } from "./errors.ts"
import type { ConnectionApiSelection, ConnectionDefinition } from "./types.ts"

const connectionValue = v.union([v.string(), v.function()])
const accessRuleSchema = v.pipe(v.unknown(), v.check(value => !Array.isArray(value)), v.object({
  read: v.optional(v.boolean()),
  write: v.optional(v.union([v.boolean(), v.literal("approve"), v.array(v.string())])),
  approve: v.optional(v.boolean()),
}))
const definitionSchema = v.looseObject({
  provider: v.looseObject({
    id: v.string(),
    authorizationEndpoint: v.string(),
    tokenEndpoint: v.string(),
    clientId: connectionValue,
    clientSecret: v.optional(connectionValue),
    account: v.function(),
    apis: v.record(v.string(), v.object({
      rootUrl: v.string(),
      methods: v.record(v.string(), v.tuple([v.string(), v.string(), v.boolean()])),
      highRisk: v.optional(v.array(v.string())),
    })),
  }),
  scopes: v.array(v.string()),
  api: v.optional(v.pipe(v.unknown(), v.check(value => !Array.isArray(value)), v.record(v.string(), v.optional(v.array(v.string()))))),
  access: v.optional(v.pipe(v.unknown(), v.check(value => !Array.isArray(value)), v.record(v.string(), accessRuleSchema))),
})
/** Validate discovered and directly declared Connections with the same contract. */
export function isConnectionDefinition(value: unknown): value is ConnectionDefinition {
  return v.is(definitionSchema, value)
}

/** Define a Connection. The file name under `server/connections/` is the Connection name. */
export function defineConnection<
  const TApis extends object,
  const TSelection extends ConnectionApiSelection<TApis> = ConnectionApiSelection<TApis>,
>(definition: ConnectionDefinition<TApis, TSelection>): ConnectionDefinition<TApis, TSelection> {
  if (!isConnectionDefinition(definition)) throw new ConnectionError("invalid", "The Connection Definition is invalid.")
  return definition
}
