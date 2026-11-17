// The Better Auth tables that `authDatabase()` owns, as data. It imports no Drizzle, so the Auth Vite plugin can list and
// check the tables of a Definition without loading the schema module.
import { authErrorDiagnostics } from "./error-diagnostics.ts"

/** The keys of the Better Auth tables. Better Auth's Drizzle adapter finds each model by this key. */
export type AuthTableName =
  | "user"
  | "session"
  | "account"
  | "verification"
  | "jwks"
  | "oauthClient"
  | "oauthResource"
  | "oauthClientResource"
  | "oauthRefreshToken"
  | "oauthAccessToken"
  | "oauthConsent"
  | "oauthClientAssertion"
  | "rateLimit"
  | "organization"
  | "member"
  | "invitation"
  | "passkey"

type AuthFieldType = "boolean" | "date" | "json" | "number" | "number[]" | "string" | "string[]"

/** One Better Auth field, in the shape of Better Auth's `getAuthTables()`. */
export interface AuthTableField {
  type: AuthFieldType
  required?: true
  unique?: true
  index?: true
  /**
   * `"now"` on a date or number field is the current time. Better Auth sets the value itself; the column default keeps a
   * plain SQL insert valid. Another string is that text, such as `"member"`.
   */
  defaultValue?: boolean | number | string | readonly string[]
  onUpdate?: true
  /** A 64-bit integer, such as a time in milliseconds. */
  bigint?: true
  references?: { model: string, field: string, onDelete?: "cascade" | "set null" }
}

export interface AuthTableSpec {
  fields: Readonly<Record<string, AuthTableField>>
  /** Unique indexes on more than one field. */
  unique?: readonly (readonly string[])[]
}

const now = "now"
const requiredString = { type: "string", required: true } as const
const optionalString = { type: "string" } as const
const optionalDate = { type: "date" } as const
const optionalBoolean = { type: "boolean" } as const
const optionalJson = { type: "json" } as const
const optionalStrings = { type: "string[]" } as const
const requiredStrings = { type: "string[]", required: true } as const
const createdAt = { type: "date", required: true, defaultValue: now } as const
const userReference = { model: "user", field: "id", onDelete: "cascade" } as const
const clientReference = { model: "oauthClient", field: "clientId", onDelete: "cascade" } as const
const sessionReference = { model: "session", field: "id", onDelete: "set null" } as const
const organizationReference = { model: "organization", field: "id", onDelete: "cascade" } as const

/**
 * The Better Auth core tables, with the fields of the plugins that ViteHub ships: `admin()` (`user.role`, bans, and
 * `session.impersonatedBy`), the `jwt()` and `oauthProvider()` tables of `mcpOAuth()`, the tables of
 * `organization()` and of `passkey()` from `@better-auth/passkey`, and the table of Better Auth's limiter. A test checks this
 * list against Better Auth's own `getAuthTables()`, so a Better Auth upgrade that changes a table fails it.
 */
export const authTableSpecs: Readonly<Record<AuthTableName, AuthTableSpec>> = {
  user: {
    fields: {
      name: requiredString,
      email: { type: "string", required: true, unique: true },
      emailVerified: { type: "boolean", required: true, defaultValue: false },
      image: optionalString,
      createdAt,
      updatedAt: { type: "date", required: true, defaultValue: now, onUpdate: true },
      role: optionalString,
      banned: { type: "boolean", defaultValue: false },
      banReason: optionalString,
      banExpires: optionalDate,
    },
  },
  session: {
    fields: {
      expiresAt: { type: "date", required: true },
      token: { type: "string", required: true, unique: true },
      createdAt,
      updatedAt: { type: "date", required: true, onUpdate: true },
      ipAddress: optionalString,
      userAgent: optionalString,
      userId: { type: "string", required: true, index: true, references: userReference },
      impersonatedBy: optionalString,
      activeOrganizationId: optionalString,
    },
  },
  account: {
    fields: {
      accountId: requiredString,
      providerId: requiredString,
      userId: { type: "string", required: true, index: true, references: userReference },
      accessToken: optionalString,
      refreshToken: optionalString,
      idToken: optionalString,
      accessTokenExpiresAt: optionalDate,
      refreshTokenExpiresAt: optionalDate,
      scope: optionalString,
      password: optionalString,
      createdAt,
      updatedAt: { type: "date", required: true, onUpdate: true },
    },
  },
  verification: {
    fields: {
      identifier: { type: "string", required: true, index: true },
      value: requiredString,
      expiresAt: { type: "date", required: true },
      createdAt,
      updatedAt: { type: "date", required: true, defaultValue: now, onUpdate: true },
    },
  },
  jwks: {
    fields: {
      publicKey: requiredString,
      privateKey: requiredString,
      createdAt: { type: "date", required: true },
      expiresAt: optionalDate,
      alg: optionalString,
      crv: optionalString,
    },
  },
  oauthClient: {
    fields: {
      clientId: { type: "string", required: true, unique: true },
      clientSecret: optionalString,
      clientDiscoveryId: optionalString,
      disabled: { type: "boolean", defaultValue: false },
      skipConsent: optionalBoolean,
      enableEndSession: optionalBoolean,
      subjectType: optionalString,
      scopes: optionalStrings,
      clientCredentialsScopes: { type: "string[]", defaultValue: [] },
      userId: { type: "string", index: true, references: userReference },
      createdAt: optionalDate,
      updatedAt: optionalDate,
      name: optionalString,
      uri: optionalString,
      icon: optionalString,
      contacts: optionalStrings,
      tos: optionalString,
      policy: optionalString,
      softwareId: optionalString,
      softwareVersion: optionalString,
      softwareStatement: optionalString,
      redirectUris: requiredStrings,
      postLogoutRedirectUris: optionalStrings,
      backchannelLogoutUri: optionalString,
      backchannelLogoutSessionRequired: optionalBoolean,
      tokenEndpointAuthMethod: optionalString,
      applicationType: optionalString,
      jwks: optionalString,
      jwksUri: optionalString,
      grantTypes: optionalStrings,
      responseTypes: optionalStrings,
      requirePKCE: optionalBoolean,
      dpopBoundAccessTokens: { type: "boolean", defaultValue: false },
      referenceId: optionalString,
      metadata: optionalJson,
    },
  },
  oauthResource: {
    fields: {
      identifier: { type: "string", required: true, unique: true },
      name: requiredString,
      accessTokenTtl: { type: "number" },
      refreshTokenTtl: { type: "number" },
      signingAlgorithm: optionalString,
      signingKeyId: optionalString,
      allowedScopes: optionalStrings,
      customClaims: optionalJson,
      dpopBoundAccessTokensRequired: { type: "boolean", defaultValue: false },
      disabled: { type: "boolean", defaultValue: false },
      createdAt: optionalDate,
      updatedAt: optionalDate,
      policyVersion: { type: "number", defaultValue: 1 },
      metadata: optionalJson,
    },
  },
  oauthClientResource: {
    fields: {
      clientId: { type: "string", required: true, index: true, references: clientReference },
      resourceId: { type: "string", required: true, index: true, references: { model: "oauthResource", field: "identifier", onDelete: "cascade" } },
      metadata: optionalJson,
      createdAt: optionalDate,
    },
    unique: [["clientId", "resourceId"]],
  },
  oauthRefreshToken: {
    fields: {
      token: { type: "string", required: true, unique: true },
      clientId: { type: "string", required: true, index: true, references: clientReference },
      sessionId: { type: "string", index: true, references: sessionReference },
      userId: { type: "string", required: true, index: true, references: userReference },
      referenceId: optionalString,
      authorizationCodeId: { type: "string", index: true },
      resources: optionalStrings,
      requestedUserInfoClaims: optionalStrings,
      expiresAt: optionalDate,
      createdAt: optionalDate,
      revoked: optionalDate,
      rotatedAt: optionalDate,
      rotationReplayResponse: optionalString,
      rotationReplayExpiresAt: optionalDate,
      authTime: optionalDate,
      confirmation: optionalJson,
      scopes: requiredStrings,
    },
  },
  oauthAccessToken: {
    fields: {
      token: { type: "string", unique: true },
      clientId: { type: "string", required: true, index: true, references: clientReference },
      sessionId: { type: "string", index: true, references: sessionReference },
      userId: { type: "string", index: true, references: userReference },
      referenceId: optionalString,
      authorizationCodeId: { type: "string", index: true },
      resources: optionalStrings,
      requestedUserInfoClaims: optionalStrings,
      refreshId: { type: "string", index: true, references: { model: "oauthRefreshToken", field: "id", onDelete: "cascade" } },
      expiresAt: optionalDate,
      createdAt: optionalDate,
      revoked: optionalDate,
      confirmation: optionalJson,
      scopes: requiredStrings,
    },
  },
  oauthConsent: {
    fields: {
      clientId: { type: "string", required: true, index: true, references: clientReference },
      userId: { type: "string", index: true, references: userReference },
      referenceId: optionalString,
      resources: optionalStrings,
      requestedUserInfoClaims: optionalStrings,
      scopes: requiredStrings,
      createdAt: optionalDate,
      updatedAt: optionalDate,
    },
  },
  oauthClientAssertion: {
    fields: {
      expiresAt: { type: "date", required: true },
    },
  },
  // Better Auth's limiter keeps its counters here, so every instance of the app sees the same counts.
  rateLimit: {
    fields: {
      key: { type: "string", required: true, unique: true },
      count: { type: "number", required: true },
      lastRequest: { type: "number", bigint: true, required: true, defaultValue: now },
    },
  },
  // `organization()`: teams, their members, and invitations. The session keeps the active team.
  organization: {
    fields: {
      name: requiredString,
      slug: { type: "string", required: true, unique: true, index: true },
      logo: optionalString,
      createdAt: { type: "date", required: true },
      metadata: optionalString,
    },
  },
  member: {
    fields: {
      organizationId: { type: "string", required: true, index: true, references: organizationReference },
      userId: { type: "string", required: true, index: true, references: userReference },
      role: { type: "string", required: true, defaultValue: "member" },
      createdAt: { type: "date", required: true },
    },
  },
  invitation: {
    fields: {
      organizationId: { type: "string", required: true, index: true, references: organizationReference },
      email: { type: "string", required: true, index: true },
      role: optionalString,
      status: { type: "string", required: true, defaultValue: "pending" },
      expiresAt: { type: "date", required: true },
      createdAt,
      inviterId: { type: "string", required: true, references: userReference },
    },
  },
  // `passkey()` from `@better-auth/passkey`.
  passkey: {
    fields: {
      name: optionalString,
      publicKey: requiredString,
      userId: { type: "string", required: true, index: true, references: userReference },
      credentialID: { type: "string", required: true, index: true },
      // WebAuthn counters are unsigned 32-bit values; Postgres integer is signed.
      counter: { type: "number", required: true, bigint: true },
      deviceType: requiredString,
      backedUp: { type: "boolean", required: true },
      transports: optionalString,
      createdAt: optionalDate,
      aaguid: optionalString,
    },
  },
}

/** The Better Auth plugins whose tables and columns `authDatabase()` adds when the Auth Definition imports them. */
export type AuthSchemaPlugin = "anonymous" | "apiKey" | "lastLoginMethod" | "phoneNumber" | "stripe" | "twoFactor" | "username"

/** The core Better Auth models. Each one takes `additionalFields`. */
export type AuthCoreModel = "user" | "session" | "account" | "verification"

interface AuthPluginSchema {
  /** Columns that the plugin adds to tables of `authTableSpecs`. */
  fields?: Partial<Record<AuthTableName, Readonly<Record<string, AuthTableField>>>>
  /** Tables that the plugin adds. */
  tables?: Readonly<Record<string, AuthTableSpec>>
}

/**
 * The tables and columns of each plugin of `AuthSchemaPlugin`, with all of its options on: a column or table that the
 * options turn off stays empty. A test checks the plugins of `better-auth/plugins` against Better Auth's own
 * `getAuthTables()`. `apiKey()` and `stripe()` are copied from `@better-auth/api-key` and `@better-auth/stripe` 1.7.
 */
export const authPluginSchemas: Readonly<Record<AuthSchemaPlugin, AuthPluginSchema>> = {
  anonymous: { fields: { user: { isAnonymous: { type: "boolean", defaultValue: false } } } },
  apiKey: {
    tables: {
      apikey: {
        fields: {
          configId: { type: "string", required: true, index: true, defaultValue: "default" },
          name: optionalString,
          start: optionalString,
          referenceId: { type: "string", required: true, index: true },
          prefix: optionalString,
          key: { type: "string", required: true, index: true },
          refillInterval: { type: "number", bigint: true },
          refillAmount: { type: "number" },
          lastRefillAt: optionalDate,
          enabled: { type: "boolean", defaultValue: true },
          rateLimitEnabled: { type: "boolean", defaultValue: true },
          rateLimitTimeWindow: { type: "number", bigint: true, defaultValue: 86_400_000 },
          rateLimitMax: { type: "number", defaultValue: 10 },
          requestCount: { type: "number", defaultValue: 0 },
          remaining: { type: "number" },
          lastRequest: optionalDate,
          expiresAt: optionalDate,
          createdAt: { type: "date", required: true },
          updatedAt: { type: "date", required: true },
          permissions: optionalString,
          metadata: optionalString,
        },
      },
    },
  },
  lastLoginMethod: { fields: { user: { lastLoginMethod: optionalString } } },
  phoneNumber: { fields: { user: { phoneNumber: { type: "string", unique: true }, phoneNumberVerified: optionalBoolean } } },
  stripe: {
    fields: { user: { stripeCustomerId: optionalString }, organization: { stripeCustomerId: optionalString } },
    tables: {
      subscription: {
        fields: {
          plan: requiredString,
          referenceId: requiredString,
          stripeCustomerId: optionalString,
          stripeSubscriptionId: optionalString,
          status: { type: "string", defaultValue: "incomplete" },
          periodStart: optionalDate,
          periodEnd: optionalDate,
          trialStart: optionalDate,
          trialEnd: optionalDate,
          cancelAtPeriodEnd: { type: "boolean", defaultValue: false },
          cancelAt: optionalDate,
          canceledAt: optionalDate,
          endedAt: optionalDate,
          seats: { type: "number" },
          billingInterval: optionalString,
          stripeScheduleId: optionalString,
        },
      },
    },
  },
  twoFactor: {
    fields: { user: { twoFactorEnabled: { type: "boolean", defaultValue: false } } },
    tables: {
      twoFactor: {
        fields: {
          secret: { type: "string", required: true, index: true },
          backupCodes: requiredString,
          userId: { type: "string", required: true, index: true, references: userReference },
          verified: { type: "boolean", defaultValue: true },
          failedVerificationCount: { type: "number", defaultValue: 0 },
          lockedUntil: optionalDate,
        },
      },
    },
  },
  username: { fields: { user: { username: { type: "string", unique: true }, displayUsername: optionalString } } },
}

/** What an Auth Definition adds to the tables of `authDatabase()`. The Auth Vite plugin reads it from the Definition. */
export interface AuthSchemaOptions {
  /** The plugins that the Definition imports. */
  plugins?: readonly AuthSchemaPlugin[]
  /** The `additionalFields` of each core model, by the key that Better Auth's adapter reads. */
  additionalFields?: Partial<Record<AuthCoreModel, Readonly<Record<string, AuthTableField>>>>
}

function sameField(left: AuthTableField, right: AuthTableField): boolean {
  return left.type === right.type && Boolean(left.required) === Boolean(right.required)
}

/**
 * The table specs for `options`: `authTableSpecs`, the tables and columns of each plugin, then the additional fields.
 * A field that a table has already must have the same type and `required`.
 */
export function resolveAuthTableSpecs(options: AuthSchemaOptions = {}): Record<string, AuthTableSpec> {
  const specs: Record<string, AuthTableSpec> = { ...authTableSpecs }
  const addFields = (model: string, fields: Readonly<Record<string, AuthTableField>>, source: string) => {
    const spec = specs[model]
    if (!spec) throw authSchemaError(`${source} adds fields to the ${JSON.stringify(model)} table, which Auth does not create`)
    const merged = { ...spec.fields }
    for (const [key, field] of Object.entries(fields)) {
      const existing = merged[key]
      if (existing && !sameField(existing, field)) throw authSchemaError(`${source} declares ${model}.${key} as ${field.type}${field.required ? ", required" : ""}, but the column is ${existing.type}${existing.required ? ", required" : ""}`)
      merged[key] ??= field
    }
    specs[model] = { ...spec, fields: merged }
  }
  for (const plugin of [...new Set(options.plugins ?? [])].sort()) {
    const schema = authPluginSchemas[plugin]
    Object.assign(specs, schema.tables)
    for (const [model, fields] of Object.entries(schema.fields ?? {})) addFields(model, fields, `${plugin}()`)
  }
  for (const [model, fields] of Object.entries(options.additionalFields ?? {})) addFields(model, fields, `${model}.additionalFields`)
  for (const [model, spec] of Object.entries(specs)) {
    for (const [key, field] of Object.entries(spec.fields)) {
      if (field.references && !specs[field.references.model]) throw authSchemaError(`${model}.${key} references the ${JSON.stringify(field.references.model)} table, which Auth does not create`)
    }
  }
  return specs
}

function authSchemaError(detail: string): Error {
  return authErrorDiagnostics.AUTH_C0056({ message: `\`authDatabase()\` cannot build its tables: ${detail}.` })
}

/** `emailVerified` becomes `email_verified` and `oauthClient` becomes `oauth_client`, as the Better Auth CLI writes them. */
export function authSqlName(name: string): string {
  return name.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase()
}
