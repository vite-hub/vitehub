import { admin } from "better-auth/plugins"
import { defineAuth } from "vite-hub/auth"
import { authDatabase } from "vite-hub/auth/database"
import { cmsAccess } from "vite-hub/cms/access"

import { playgroundRoleOf } from "./roles"

export default defineAuth({
  appName: "Content playground",
  database: authDatabase("content"),
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
