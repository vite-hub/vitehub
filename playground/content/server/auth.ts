import { admin } from "better-auth/plugins"
import { defineAuth } from "vite-hub/auth"
import { cmsAccess } from "vite-hub/cms/access"

import { playgroundRoleOf } from "./roles"

// In-memory users and sessions. Restarting the server signs everyone out. Sign in at /login.
// `admin(cmsAccess)` keeps each user's CMS role in `user.role`. A playground user gets its role at sign-up; anyone else
// gets `user`, which has no CMS permission. Admins change roles in the Console Auth section.
export default defineAuth({
  appName: "Content playground",
  emailAndPassword: { enabled: true },
  plugins: [admin(cmsAccess)],
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const role = playgroundRoleOf(user.email)
          return { data: role ? { ...user, role } : user }
        },
      },
    },
  },
})
