import { admin } from "better-auth/plugins"

/** Better Auth's admin plugin, for tests in packages that do not depend on Better Auth. */
export const adminPlugin: typeof admin = admin
