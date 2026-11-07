// Better Auth tables (user, session, account, verification, rate_limit), its OAuth provider's (./oauth.ts), its teams
// and billing (./teams.ts), and Drop's own (./drops.ts).
import { defineDatabase } from "vite-hub/database"
import { sql } from "drizzle-orm"
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { quotaReservations } from "./quotas"
import { abuseReports } from "./trust"
import { skillSettings } from "./skills"
import { reviewSubmissions } from "./review-submissions"
import { invitation, member, organization, subscription } from "./teams"
import {
  blobCleanup,
  codeImages,
  commentAttachments,
  commentCleanup,
  dropFiles,
  drops,
  dropTexts,
  dropViewers,
  dropViews,
  dropVersions,
  dropVisits,
  suggestionAcceptances,
} from "./drops"
import {
  jwks,
  oauthAccessToken,
  oauthClient,
  oauthClientAssertion,
  oauthClientResource,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
} from "./oauth"

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).default(false).notNull(),
  image: text("image"),
  role: text("role"),
  plan: text("plan", { enum: ["free", "pro", "unlimited"] }),
  shareApprovedAt: integer("share_approved_at"),
  githubCreatedAt: integer("github_created_at"),
  banned: integer("banned", { mode: "boolean" }).default(false),
  banReason: text("ban_reason"),
  banExpires: integer("ban_expires", { mode: "timestamp_ms" }),
  stripeCustomerId: text("stripe_customer_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date())
    .notNull(),
})

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    impersonatedBy: text("impersonated_by"),
    activeOrganizationId: text("active_organization_id"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
)

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
)

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
)

// Better Auth's rate limits (`rateLimit.storage: "database"`, server/auth.ts): Drop builds its Auth per request, so a
// counter in memory would start empty every time.
export const rateLimit = sqliteTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull(),
})

export {
  invitation,
  member,
  organization,
  subscription,
  quotaReservations,
  abuseReports,
  skillSettings,
  reviewSubmissions,
  blobCleanup,
  codeImages,
  commentAttachments,
  commentCleanup,
  dropFiles,
  drops,
  dropTexts,
  dropViewers,
  dropViews,
  dropVersions,
  dropVisits,
  suggestionAcceptances,
  jwks,
  oauthAccessToken,
  oauthClient,
  oauthClientAssertion,
  oauthClientResource,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
}

// Where it lives (D1 binding, D1 over HTTP, or local SQLite) is per host, in nuxt.config.ts `vitehub.database`.
export default defineDatabase({
  schema: {
    quotaReservations,
    abuseReports,
    skillSettings,
    reviewSubmissions,
    account,
    blobCleanup,
    codeImages,
    commentAttachments,
    commentCleanup,
    dropFiles,
    drops,
    dropTexts,
    dropViewers,
    dropViews,
    dropVersions,
    dropVisits,
    suggestionAcceptances,
    invitation,
    jwks,
    member,
    oauthAccessToken,
    oauthClient,
    oauthClientAssertion,
    oauthClientResource,
    oauthConsent,
    oauthRefreshToken,
    oauthResource,
    organization,
    rateLimit,
    session,
    subscription,
    user,
    verification,
  },
})
