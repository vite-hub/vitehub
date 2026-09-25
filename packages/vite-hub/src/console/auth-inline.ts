import { DatabaseSync } from "node:sqlite"

import { defineAuth } from "@vite-hub/auth"

import { defineConsoleAuth, type ConsoleAuthDefinition } from "./auth.ts"

export interface InlineConsoleAuth {
  provider: "github"
  allowedEmails: string[]
  databasePath: string
  baseURL?: string
  client?: string
  clientIdEnv?: string
  clientSecretEnv?: string
  secretEnv?: string
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new TypeError(`[vitehub] Console Auth requires ${name}.`)
  return value
}

export function createInlineConsoleAuth(config: InlineConsoleAuth): ConsoleAuthDefinition {
  if (config.provider !== "github" || !Array.isArray(config.allowedEmails) || config.allowedEmails.length === 0) {
    throw new TypeError("[vitehub] Inline Console Auth requires GitHub and a non-empty allowedEmails list.")
  }
  if (!config.databasePath || config.databasePath === ":memory:") {
    throw new TypeError("[vitehub] Inline Console Auth requires a persistent databasePath.")
  }
  const database = new DatabaseSync(config.databasePath)
  const allowedEmails = new Set(config.allowedEmails.map(email => email.toLowerCase()))
  return defineConsoleAuth({
    auth: defineAuth(({ requestOrigin }) => ({
      appName: "ViteHub Console",
      baseURL: config.baseURL ?? process.env.CONSOLE_AUTH_BASE_URL ?? requestOrigin,
      database,
      secret: requiredEnv(config.secretEnv ?? "BETTER_AUTH_SECRET"),
      socialProviders: {
        github: {
          clientId: requiredEnv(config.clientIdEnv ?? "GITHUB_CLIENT_ID"),
          clientSecret: requiredEnv(config.clientSecretEnv ?? "GITHUB_CLIENT_SECRET"),
        },
      },
    })),
    authorize: ({ user }) => user.emailVerified === true
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Better Auth user fields are extensible, so verify email is a string before comparing it with the allowlist.
      && typeof user.email === "string"
      && allowedEmails.has(user.email.toLowerCase()),
    signIn: { provider: "github", scopes: ["user:email"] },
  })
}
