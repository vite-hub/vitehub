import { passkey } from "@better-auth/passkey"
import { organization } from "better-auth/plugins"
import { defineAuth } from "vite-hub/auth"
import { authDatabase } from "vite-hub/auth/database"
import { mcpOAuth } from "vite-hub/auth/mcp"
import { useDatabase } from "vite-hub/database"

import { adoptGitHubEmail, passkeySignUp, sessionTeam } from "../src/accounts.ts"
import { consoleCliDeviceFlow, consoleDeviceDisabledPaths } from "../src/device.ts"
import { keepConsoleSignInMethod } from "../src/sign-in-methods.ts"

export default defineAuth(({ env, requestOrigin }) => ({
  appName: "ViteHub Console",
  database: authDatabase(),
  socialProviders: env.auth.github.clientId
    ? { github: { clientId: env.auth.github.clientId, clientSecret: env.auth.github.clientSecret?.unseal() ?? "" } }
    : {},
  account: { accountLinking: { allowDifferentEmails: true } },
  disabledPaths: [...consoleDeviceDisabledPaths],
  databaseHooks: {
    account: {
      create: {
        async after(account, context) {
          await adoptGitHubEmail(account, context)
        },
      },
      update: {
        async after(account, context) {
          await adoptGitHubEmail(account, context)
        },
      },
    },
    session: {
      create: {
        async before(session, context) {
          const team = await sessionTeam(session.userId, context)
          return { data: { ...session, activeOrganizationId: team ?? null } }
        },
      },
    },
  },
  plugins: [
    organization({ creatorRole: "owner" }),
    passkey({ rpName: "ViteHub Console", registration: passkeySignUp }),
    keepConsoleSignInMethod(),
    ...consoleCliDeviceFlow({ database: () => useDatabase("default").db }),
    ...mcpOAuth({ loginPage: "/oauth", provider: { allowPublicClientPrelogin: true }, resource: `${requestOrigin}/mcp/account` }),
  ],
}))
