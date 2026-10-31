import { createAccessControl } from "better-auth/plugins/access"
import { adminAc, defaultStatements, userAc } from "better-auth/plugins/admin/access"

import type { CommentsAuthorizeContext } from "@vite-hub/comments"
import type { ContentAuthorize } from "@vite-hub/content"
import type { AccessControl, Role, RoleAuthorizeRequest, Statements } from "better-auth/plugins/access"

/**
 * The permissions of the Better Auth `admin` plugin, `user` and `session`, plus the CMS resources: `content` for the
 * actions of `content.can()`, and `comment` for Comments. `comment:delete` removes threads of other people.
 */
export type CmsStatements = typeof defaultStatements & {
  readonly content: readonly ["read", "write", "publish"]
  readonly comment: readonly ["read", "create", "resolve", "delete"]
}

/** The statements of `cmsAc`. */
export const cmsStatements: CmsStatements = {
  ...defaultStatements,
  content: ["read", "write", "publish"],
  comment: ["read", "create", "resolve", "delete"],
}

/** The access control of the CMS roles, for `admin({ ac })` of Better Auth. */
export const cmsAc: AccessControl<CmsStatements> = createAccessControl(cmsStatements)

/**
 * A CMS role. `user` is the default role of Better Auth and has no CMS permission. Each of `viewer`, `commenter`,
 * `editor`, and `publisher` has the permissions of the role before it, and `admin` has every permission.
 */
export type CmsRoleName = "user" | "viewer" | "commenter" | "editor" | "publisher" | "admin"

/** A Better Auth role on `cmsAc`. */
export type CmsRole = Role<Statements, CmsStatements>

/** What `cmsCan()` checks, such as `{ content: ["publish"] }`. Several actions must all be allowed. */
export type CmsPermissions = RoleAuthorizeRequest<CmsStatements>

/** A signed-in user, such as the Better Auth session user. The `admin` plugin keeps its roles in `role`. */
export type CmsUser = Readonly<Record<string, unknown>>

const comments: CmsStatements["comment"][number][] = ["read", "create", "resolve"]

/** The CMS roles, for `admin({ roles })` of Better Auth. */
export const cmsRoles: Readonly<Record<CmsRoleName, CmsRole>> = {
  user: cmsAc.newRole(userAc.statements),
  viewer: cmsAc.newRole({ content: ["read"] }),
  commenter: cmsAc.newRole({ content: ["read"], comment: comments }),
  editor: cmsAc.newRole({ content: ["read", "write"], comment: comments }),
  publisher: cmsAc.newRole({ content: ["read", "write", "publish"], comment: cmsStatements.comment }),
  admin: cmsAc.newRole({ ...adminAc.statements, content: cmsStatements.content, comment: cmsStatements.comment }),
}

/** The options of the Better Auth `admin` plugin with the CMS roles. */
export interface CmsAccessOptions {
  ac: AccessControl<CmsStatements>
  roles: Readonly<Record<CmsRoleName, CmsRole>>
  /** New users get `user`, which has no CMS permission. */
  defaultRole: "user"
  adminRoles: string[]
}

/**
 * Better Auth `admin` plugin options with the CMS roles: `admin(cmsAccess)`. Users start with the `user` role, which
 * has no CMS permission. Give a user a role with the admin API, such as `auth.api.setRole()`, or in the Console.
 */
export const cmsAccess: CmsAccessOptions = { ac: cmsAc, roles: cmsRoles, defaultRole: "user", adminRoles: ["admin"] }

function isCmsRoleName(name: string): name is CmsRoleName {
  return Object.hasOwn(cmsRoles, name)
}

/** The known CMS roles of a user. `role` holds one role, or several separated by commas, as Better Auth stores them. */
function cmsRolesOf(user: CmsUser | null | undefined): CmsRoleName[] {
  const role = user?.role
  if (String(role) !== role) return []
  return role.split(",").map(name => name.trim()).filter(isCmsRoleName)
}

/**
 * Whether one of the CMS roles of `user` allows every action in `permissions`. A missing user, a user without a role,
 * and unknown roles are denied. It reads only `user.role`, so it needs no request.
 */
export function cmsCan(user: CmsUser | null | undefined, permissions: CmsPermissions): boolean {
  return cmsRolesOf(user).some(name => cmsRoles[name].authorize(permissions).success)
}

/**
 * `defineContent({ authorize })` from the CMS roles: `content.can()` allows an action when a role of the user has
 * `content:<action>`. `defineContent({ extends: cms })` uses it when the app sets no `authorize`.
 */
export const cmsContentAuthorize: ContentAuthorize = ({ user, action }) => cmsCan(user, { content: [action] })

/** The `comment` permission of each Comments action. Operations Comments name creating `write`. Only `publisher` and `admin` delete. */
const commentPermissions: Readonly<Record<CommentsAuthorizeContext["action"], CmsStatements["comment"][number]>> = {
  read: "read",
  comment: "create",
  write: "create",
  resolve: "resolve",
  delete: "delete",
}

/**
 * `defineComments({ authorize })` from the CMS roles: `read` needs `comment:read`, `comment` needs `comment:create`,
 * and `resolve` needs `comment:resolve`.
 */
export function cmsCommentsAuthorize(context: Pick<CommentsAuthorizeContext, "user" | "action">): boolean {
  if (!Object.hasOwn(commentPermissions, context.action)) return false
  return cmsCan(context.user, { comment: [commentPermissions[context.action]] })
}

/**
 * `defineConsoleAuthorize()` from the CMS roles. `admin` uses every Console section. Other roles use the `content`
 * section with `content:read` and the `comments` section with `comment:read`. A user without either gets `403`.
 */
export function cmsConsoleAuthorize(context: { user?: CmsUser | null }): true | { sections: string[] } {
  if (cmsRolesOf(context.user).includes("admin")) return true
  const sections: string[] = []
  if (cmsCan(context.user, { content: ["read"] })) sections.push("content")
  if (cmsCan(context.user, { comment: ["read"] })) sections.push("comments")
  return { sections }
}
