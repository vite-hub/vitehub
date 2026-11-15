import { passkey } from "@better-auth/passkey"
import { organization } from "better-auth/plugins"
import { defineAuth } from "vite-hub/auth"
import { authDatabase } from "vite-hub/auth/database"
import { mcpOAuth } from "vite-hub/auth/mcp"

import { adoptGitHubEmail, passkeySignUp, sessionTeam } from "../src/accounts.ts"
import { keepConsoleSignInMethod } from "../src/sign-in-methods.ts"

// Anyone can sign up with GitHub or a passkey. Each account gets a personal team, and projects belong to teams.
export default defineAuth(({ env, requestOrigin }) => ({
  appName: "ViteHub Console",
  database: authDatabase(),
  socialProviders: env.auth.github.clientId
    ? { github: { clientId: env.auth.github.clientId, clientSecret: env.auth.github.clientSecret?.unseal() ?? "" } }
    : {},
  // A passkey account links GitHub later. Its email is a placeholder, so the GitHub email cannot match it. The account
  // hook then gives it the verified GitHub email.
  account: { accountLinking: { allowDifferentEmails: true } },
  databaseHooks: {
    // A link creates the account, and connecting GitHub again updates it. Both retry the email of a passkey account.
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
    // MCP clients sign in to /mcp/account with OAuth. /oauth is the sign-in and consent page (server/routes/oauth.ts).
    // The page shows the name that the client registered before the person signs in.
    ...mcpOAuth({ loginPage: "/oauth", provider: { allowPublicClientPrelogin: true }, resource: `${requestOrigin}/mcp/account` }),
  ],
}))
