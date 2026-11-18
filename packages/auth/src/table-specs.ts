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

const requiredString = { type: "string", required: true } as const
const optionalString = { type: "string" } as const
const optionalDate = { type: "date" } as const
const optionalBoolean = { type: "boolean" } as const
const userReference = { model: "user", field: "id", onDelete: "cascade" } as const

// A plain literal, so that `AuthSqliteSchema` and `AuthPostgresSchema` can type each column from it.
const coreTableSpecs = {
  user: {
    fields: {
      name: { type: "string", required: true },
      email: { type: "string", required: true, unique: true },
      emailVerified: { type: "boolean", required: true, defaultValue: false },
      image: { type: "string" },
      createdAt: { type: "date", required: true, defaultValue: "now" },
      updatedAt: { type: "date", required: true, defaultValue: "now", onUpdate: true },
      role: { type: "string" },
      banned: { type: "boolean", defaultValue: false },
      banReason: { type: "string" },
      banExpires: { type: "date" },
    },
  },
  session: {
    fields: {
      expiresAt: { type: "date", required: true },
      token: { type: "string", required: true, unique: true },
      createdAt: { type: "date", required: true, defaultValue: "now" },
      updatedAt: { type: "date", required: true, onUpdate: true },
      ipAddress: { type: "string" },
      userAgent: { type: "string" },
      userId: { type: "string", required: true, index: true, references: { model: "user", field: "id", onDelete: "cascade" } },
      impersonatedBy: { type: "string" },
      activeOrganizationId: { type: "string" },
    },
  },
  account: {
    fields: {
      accountId: { type: "string", required: true },
      providerId: { type: "string", required: true },
      userId: { type: "string", required: true, index: true, references: { model: "user", field: "id", onDelete: "cascade" } },
      accessToken: { type: "string" },
      refreshToken: { type: "string" },
      idToken: { type: "string" },
      accessTokenExpiresAt: { type: "date" },
      refreshTokenExpiresAt: { type: "date" },
      scope: { type: "string" },
      password: { type: "string" },
      createdAt: { type: "date", required: true, defaultValue: "now" },
      updatedAt: { type: "date", required: true, onUpdate: true },
    },
  },
  verification: {
    fields: {
      identifier: { type: "string", required: true, index: true },
      value: { type: "string", required: true },
      expiresAt: { type: "date", required: true },
      createdAt: { type: "date", required: true, defaultValue: "now" },
      updatedAt: { type: "date", required: true, defaultValue: "now", onUpdate: true },
    },
  },
  jwks: {
    fields: {
      publicKey: { type: "string", required: true },
      privateKey: { type: "string", required: true },
      createdAt: { type: "date", required: true },
      expiresAt: { type: "date" },
      alg: { type: "string" },
      crv: { type: "string" },
    },
  },
  oauthClient: {
    fields: {
      clientId: { type: "string", required: true, unique: true },
      clientSecret: { type: "string" },
      clientDiscoveryId: { type: "string" },
      disabled: { type: "boolean", defaultValue: false },
      skipConsent: { type: "boolean" },
      enableEndSession: { type: "boolean" },
      subjectType: { type: "string" },
      scopes: { type: "string[]" },
      clientCredentialsScopes: { type: "string[]", defaultValue: [] },
      userId: { type: "string", index: true, references: { model: "user", field: "id", onDelete: "cascade" } },
      createdAt: { type: "date" },
      updatedAt: { type: "date" },
      name: { type: "string" },
      uri: { type: "string" },
      icon: { type: "string" },
      contacts: { type: "string[]" },
      tos: { type: "string" },
      policy: { type: "string" },
      softwareId: { type: "string" },
      softwareVersion: { type: "string" },
      softwareStatement: { type: "string" },
      redirectUris: { type: "string[]", required: true },
      postLogoutRedirectUris: { type: "string[]" },
      backchannelLogoutUri: { type: "string" },
      backchannelLogoutSessionRequired: { type: "boolean" },
      tokenEndpointAuthMethod: { type: "string" },
      applicationType: { type: "string" },
      jwks: { type: "string" },
      jwksUri: { type: "string" },
      grantTypes: { type: "string[]" },
      responseTypes: { type: "string[]" },
      requirePKCE: { type: "boolean" },
      dpopBoundAccessTokens: { type: "boolean", defaultValue: false },
      referenceId: { type: "string" },
      metadata: { type: "json" },
    },
  },
  oauthResource: {
    fields: {
      identifier: { type: "string", required: true, unique: true },
      name: { type: "string", required: true },
      accessTokenTtl: { type: "number" },
      refreshTokenTtl: { type: "number" },
      signingAlgorithm: { type: "string" },
      signingKeyId: { type: "string" },
      allowedScopes: { type: "string[]" },
      customClaims: { type: "json" },
      dpopBoundAccessTokensRequired: { type: "boolean", defaultValue: false },
      disabled: { type: "boolean", defaultValue: false },
      createdAt: { type: "date" },
      updatedAt: { type: "date" },
      policyVersion: { type: "number", defaultValue: 1 },
      metadata: { type: "json" },
    },
  },
  oauthClientResource: {
    fields: {
      clientId: { type: "string", required: true, index: true, references: { model: "oauthClient", field: "clientId", onDelete: "cascade" } },
      resourceId: { type: "string", required: true, index: true, references: { model: "oauthResource", field: "identifier", onDelete: "cascade" } },
      metadata: { type: "json" },
      createdAt: { type: "date" },
    },
    unique: [["clientId", "resourceId"]],
  },
  oauthRefreshToken: {
    fields: {
      token: { type: "string", required: true, unique: true },
      clientId: { type: "string", required: true, index: true, references: { model: "oauthClient", field: "clientId", onDelete: "cascade" } },
      sessionId: { type: "string", index: true, references: { model: "session", field: "id", onDelete: "set null" } },
      userId: { type: "string", required: true, index: true, references: { model: "user", field: "id", onDelete: "cascade" } },
      referenceId: { type: "string" },
      authorizationCodeId: { type: "string", index: true },
      resources: { type: "string[]" },
      requestedUserInfoClaims: { type: "string[]" },
      expiresAt: { type: "date" },
      createdAt: { type: "date" },
      revoked: { type: "date" },
      rotatedAt: { type: "date" },
      rotationReplayResponse: { type: "string" },
      rotationReplayExpiresAt: { type: "date" },
      authTime: { type: "date" },
      confirmation: { type: "json" },
      scopes: { type: "string[]", required: true },
    },
  },
  oauthAccessToken: {
    fields: {
      token: { type: "string", unique: true },
      clientId: { type: "string", required: true, index: true, references: { model: "oauthClient", field: "clientId", onDelete: "cascade" } },
      sessionId: { type: "string", index: true, references: { model: "session", field: "id", onDelete: "set null" } },
      userId: { type: "string", index: true, references: { model: "user", field: "id", onDelete: "cascade" } },
      referenceId: { type: "string" },
      authorizationCodeId: { type: "string", index: true },
      resources: { type: "string[]" },
      requestedUserInfoClaims: { type: "string[]" },
      refreshId: { type: "string", index: true, references: { model: "oauthRefreshToken", field: "id", onDelete: "cascade" } },
      expiresAt: { type: "date" },
      createdAt: { type: "date" },
      revoked: { type: "date" },
      confirmation: { type: "json" },
      scopes: { type: "string[]", required: true },
    },
  },
  oauthConsent: {
    fields: {
      clientId: { type: "string", required: true, index: true, references: { model: "oauthClient", field: "clientId", onDelete: "cascade" } },
      userId: { type: "string", index: true, references: { model: "user", field: "id", onDelete: "cascade" } },
      referenceId: { type: "string" },
      resources: { type: "string[]" },
      requestedUserInfoClaims: { type: "string[]" },
      scopes: { type: "string[]", required: true },
      createdAt: { type: "date" },
      updatedAt: { type: "date" },
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
      lastRequest: { type: "number", bigint: true, required: true, defaultValue: "now" },
    },
  },
  // `organization()`: teams, their members, and invitations. The session keeps the active team.
  organization: {
    fields: {
      name: { type: "string", required: true },
      slug: { type: "string", required: true, unique: true, index: true },
      logo: { type: "string" },
      createdAt: { type: "date", required: true },
      metadata: { type: "string" },
    },
  },
  member: {
    fields: {
      organizationId: { type: "string", required: true, index: true, references: { model: "organization", field: "id", onDelete: "cascade" } },
      userId: { type: "string", required: true, index: true, references: { model: "user", field: "id", onDelete: "cascade" } },
      role: { type: "string", required: true, defaultValue: "member" },
      createdAt: { type: "date", required: true },
    },
  },
  invitation: {
    fields: {
      organizationId: { type: "string", required: true, index: true, references: { model: "organization", field: "id", onDelete: "cascade" } },
      email: { type: "string", required: true, index: true },
      role: { type: "string" },
      status: { type: "string", required: true, defaultValue: "pending" },
      expiresAt: { type: "date", required: true },
      createdAt: { type: "date", required: true, defaultValue: "now" },
      inviterId: { type: "string", required: true, references: { model: "user", field: "id", onDelete: "cascade" } },
    },
  },
  // `passkey()` from `@better-auth/passkey`.
  passkey: {
    fields: {
      name: { type: "string" },
      publicKey: { type: "string", required: true },
      userId: { type: "string", required: true, index: true, references: { model: "user", field: "id", onDelete: "cascade" } },
      credentialID: { type: "string", required: true, index: true },
      // WebAuthn counters are unsigned 32-bit values; Postgres integer is signed.
      counter: { type: "number", required: true, bigint: true },
      deviceType: { type: "string", required: true },
      backedUp: { type: "boolean", required: true },
      transports: { type: "string" },
      createdAt: { type: "date" },
      aaguid: { type: "string" },
    },
  },
} as const

/** The literal type of `authTableSpecs`, which types the columns of the Auth tables. */
export type AuthCoreTableSpecs = typeof coreTableSpecs

/**
 * The Better Auth core tables, with the fields of the plugins that ViteHub ships: `admin()` (`user.role`, bans, and
 * `session.impersonatedBy`), the `jwt()` and `oauthProvider()` tables of `mcpOAuth()`, the tables of
 * `organization()` and of `passkey()` from `@better-auth/passkey`, and the table of Better Auth's limiter. A test checks this
 * list against Better Auth's own `getAuthTables()`, so a Better Auth upgrade that changes a table fails it.
 */
export const authTableSpecs: Readonly<Record<AuthTableName, AuthTableSpec>> = coreTableSpecs

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
