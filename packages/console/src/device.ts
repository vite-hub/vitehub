import { APIError } from "better-auth"
import { createAuthEndpoint, sessionMiddleware } from "better-auth/api"
import { deviceAuthorization, redeemDeviceCode } from "better-auth/plugins"
import * as z from "zod"

import { isPasskeyEmail } from "./accounts.ts"
import { createConsoleApiKey, defaultApiKeyDays } from "./api-keys.ts"

import type { BetterAuthPlugin } from "better-auth"
import type { DeviceAuthorizationGrant, DeviceCode } from "better-auth/plugins"
import type { ConsoleDatabase } from "./projects.ts"

/** The `client_id` of the ViteHub CLI. The Console accepts no other device client. */
export const consoleCliClientId = "vitehub-cli"

/** Better Auth's own approve and session endpoints of the device flow. The Console uses `/cli/approve` and `/cli/token`. */
export const consoleDeviceDisabledPaths = ["/device/approve", "/device/token"] as const

/** The Console page where a person types the code that the CLI prints. */
export const consoleDevicePath = "/device"

type ConsoleDeviceCode = DeviceCode & { clientName?: string | null, teamId?: string | null }

const requestFields = { client_name: z.string().max(200).optional() }

const cliGrant: DeviceAuthorizationGrant<typeof requestFields, { client_name: string | null }> = {
  requestSchemaFields: requestFields,
  deviceCodeSchemaFields: {
    clientName: { type: "string", required: false },
    teamId: { type: "string", required: false },
  },
  authorizeRequest: ({ request }) => request.client_id === consoleCliClientId
    ? { clientId: consoleCliClientId, deviceCodeFields: { clientName: request.client_name?.trim() || null } }
    : undefined,
  assertSessionRedemption: () => {
    throw new APIError("BAD_REQUEST", { error: "invalid_grant", error_description: "The ViteHub CLI gets an API key from /api/auth/cli/token." })
  },
  getVerificationContext: code => ({ client_name: typeof code.clientName === "string" ? code.clientName : null }),
}

export interface ConsoleCliOptions {
  /** The Console Database, where the API keys live. */
  database: () => ConsoleDatabase
  /** How long a code waits for the person. Defaults to 15 minutes. */
  expiresIn?: `${number}m` | `${number}s`
  /** The polling interval that the CLI must keep. Defaults to 5 seconds. */
  interval?: `${number}s`
}

/**
 * Sign-in for the ViteHub CLI with the device flow of RFC 8628:
 *
 * 1. The CLI posts `client_id=vitehub-cli` to `/api/auth/device/code` and prints the code and `/device`.
 * 2. On `/device`, the signed-in person checks the machine name, picks a team, and approves (`/api/auth/cli/approve`)
 *    or denies (`/api/auth/device/deny`).
 * 3. The CLI polls `/api/auth/cli/token`. It answers `authorization_pending`, `slow_down` when the CLI polls faster than
 *    the interval, `access_denied`, or `expired_token`, and after approval an API key for the team that expires in 90
 *    days. The code works once.
 *
 * Better Auth's limiter counts the requests to both endpoints in the `rate_limit` table.
 */
export function consoleCliDeviceFlow(options: ConsoleCliOptions): BetterAuthPlugin[] {
  const device = deviceAuthorization({
    expiresIn: options.expiresIn ?? "15m",
    interval: options.interval ?? "5s",
    verificationUri: consoleDevicePath,
    grant: cliGrant,
  })
  const cli = {
    id: "console-cli",
    rateLimit: [
      { pathMatcher: (path: string) => path === "/device/code", window: 60, max: 10 },
      { pathMatcher: (path: string) => path === "/cli/token", window: 60, max: 30 },
    ],
    endpoints: {
      consoleCliApprove: createAuthEndpoint("/cli/approve", {
        method: "POST",
        body: z.object({ userCode: z.string().min(1), teamId: z.string().min(1) }),
        use: [sessionMiddleware],
        requireHeaders: true,
      }, async (ctx) => {
        ctx.setHeader("cache-control", "no-store")
        const userId = ctx.context.session.user.id
        const userCode = ctx.body.userCode.replace(/[^a-z0-9]/gi, "").toUpperCase()
        const membership = await ctx.context.adapter.findOne({ model: "member", where: [{ field: "organizationId", value: ctx.body.teamId }, { field: "userId", value: userId }] })
        if (!membership) throw new APIError("FORBIDDEN", { error: "access_denied", error_description: "Choose a team that you are a member of." })
        const code = await ctx.context.adapter.findOne<ConsoleDeviceCode>({ model: "deviceCode", where: [{ field: "userCode", value: userCode }] })
        if (!code || code.clientId !== consoleCliClientId) throw new APIError("BAD_REQUEST", { error: "invalid_request", error_description: "There is no such code. Check it in the terminal." })
        if (new Date(code.expiresAt) < new Date()) throw new APIError("BAD_REQUEST", { error: "expired_token", error_description: "The code expired. Run `vitehub login` again." })
        if (code.userId !== userId) throw new APIError("FORBIDDEN", { error: "access_denied", error_description: "Open the code on this page before you approve it." })
        const approved = await ctx.context.adapter.update<ConsoleDeviceCode>({
          model: "deviceCode",
          where: [{ field: "id", value: code.id }, { field: "status", value: "pending" }, { field: "userId", value: userId }],
          update: { status: "approved", teamId: ctx.body.teamId },
        })
        if (!approved) throw new APIError("BAD_REQUEST", { error: "invalid_request", error_description: "The code was already approved or denied." })
        return ctx.json({ success: true })
      }),
      consoleCliToken: createAuthEndpoint("/cli/token", {
        method: "POST",
        body: z.object({ device_code: z.string().min(1), client_id: z.string().min(1) }),
        metadata: { noStore: true, allowedMediaTypes: ["application/json", "application/x-www-form-urlencoded"] },
      }, async (ctx) => {
        ctx.setHeader("cache-control", "no-store")
        ctx.setHeader("pragma", "no-cache")
        if (ctx.body.client_id !== consoleCliClientId) throw new APIError("BAD_REQUEST", { error: "invalid_client" })
        const { claimedDeviceCode, user } = await redeemDeviceCode<{ clientName?: string | null, teamId?: string | null }, undefined, undefined>({
          ctx,
          deviceCode: ctx.body.device_code,
          authorizeRedemption: (code) => {
            if (code.clientId !== consoleCliClientId) throw new APIError("BAD_REQUEST", { error: "invalid_grant" })
            return { ownershipWhere: { field: "clientId", value: consoleCliClientId }, context: undefined }
          },
          prepareRedemption: () => undefined,
        })
        const teamId = claimedDeviceCode.teamId
        if (!teamId) throw new APIError("BAD_REQUEST", { error: "invalid_grant", error_description: "The code was approved without a team. Run `vitehub login` again." })
        const created = await createConsoleApiKey(options.database(), {
          userId: user.id,
          teamId,
          name: claimedDeviceCode.clientName || "vitehub CLI",
          days: defaultApiKeyDays,
        })
        if (!created) throw new APIError("BAD_REQUEST", { error: "access_denied", error_description: "You are no longer a member of the team." })
        return ctx.json({
          access_token: created.key,
          token_type: "Bearer",
          expires_in: Math.floor((created.apiKey.expiresAt - Date.now()) / 1000),
          scope: "",
          key_id: created.apiKey.id,
          team: created.apiKey.team,
          user: { id: user.id, name: user.name, ...(isPasskeyEmail(user.email) ? {} : { email: user.email }) },
        })
      }),
    },
  } satisfies BetterAuthPlugin
  return [device, cli]
}
