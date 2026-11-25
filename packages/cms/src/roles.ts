import type * as BetterAuthAccess from "better-auth/plugins/access"
import type { AccessControl } from "better-auth/plugins/access"
import type * as BetterAuthAdminAccess from "better-auth/plugins/admin/access"

import type { CmsPermissions, CmsRole, CmsRoleName, CmsStatements, CmsUser } from "./access.ts"

export interface CmsRoleSet {
  statements: CmsStatements
  ac: AccessControl<CmsStatements>
  roles: Readonly<Record<CmsRoleName, CmsRole>>
  rolesOf: (user: CmsUser | null | undefined) => CmsRoleName[]
  can: (user: CmsUser | null | undefined, permissions: CmsPermissions) => boolean
}

/**
 * Builds the CMS roles from the Better Auth modules that the caller loaded. The root entry loads `better-auth` with a
 * dynamic import of the package, not of `./access.ts`: Nitro dev bundles the app into one file, and `./access.ts` would
 * then load `better-auth` when the app starts, also in apps that do not install it.
 */
export function createCmsRoles(access: typeof BetterAuthAccess, adminAccess: typeof BetterAuthAdminAccess): CmsRoleSet {
  const statements: CmsStatements = {
    ...adminAccess.defaultStatements,
    content: ["read", "read-draft", "write", "publish"],
    comment: ["read", "create", "resolve", "delete"],
  }
  const ac = access.createAccessControl(statements)
  const comments: CmsStatements["comment"][number][] = ["read", "create", "resolve"]
  const roles: Readonly<Record<CmsRoleName, CmsRole>> = {
    user: ac.newRole(adminAccess.userAc.statements),
    viewer: ac.newRole({ content: ["read", "read-draft"] }),
    commenter: ac.newRole({ content: ["read", "read-draft"], comment: comments }),
    editor: ac.newRole({ content: ["read", "read-draft", "write"], comment: comments }),
    publisher: ac.newRole({ content: ["read", "read-draft", "write", "publish"], comment: statements.comment }),
    admin: ac.newRole({ ...adminAccess.adminAc.statements, content: statements.content, comment: statements.comment }),
  }
  const isRoleName = (name: string): name is CmsRoleName => Object.hasOwn(roles, name)
  const rolesOf = (user: CmsUser | null | undefined): CmsRoleName[] => {
    const role = user?.role
    if (String(role) !== role) return []
    return role.split(",").map(name => name.trim()).filter(isRoleName)
  }
  return {
    statements,
    ac,
    roles,
    rolesOf,
    can: (user, permissions) => rolesOf(user).some(name => roles[name].authorize(permissions).success),
  }
}
