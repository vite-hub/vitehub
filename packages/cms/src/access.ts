import * as betterAuthAccess from "better-auth/plugins/access"
import * as betterAuthAdminAccess from "better-auth/plugins/admin/access"

import type { CommentsAuthorizeContext } from "@vite-hub/comments"
import type { ContentAuthorize } from "@vite-hub/content"
import type { AccessControl, Role, RoleAuthorizeRequest, Statements } from "better-auth/plugins/access"

import { createCmsRoles } from "./roles.ts"

/**
 * The permissions of the Better Auth `admin` plugin, `user` and `session`, plus the CMS resources: `content` for the
 * actions of `content.can()`, and `comment` for Comments. `comment:delete` removes threads of other people.
 */
export type CmsStatements = typeof betterAuthAdminAccess.defaultStatements & {
  readonly content: readonly ["read", "read-draft", "write", "publish"]
  readonly comment: readonly ["read", "create", "resolve", "delete"]
}

const cms = createCmsRoles(betterAuthAccess, betterAuthAdminAccess)

/** The statements of `cmsAc`. */
export const cmsStatements: CmsStatements = cms.statements

/** The access control of the CMS roles, for `admin({ ac })` of Better Auth. */
export const cmsAc: AccessControl<CmsStatements> = cms.ac

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

/** The CMS roles, for `admin({ roles })` of Better Auth. */
export const cmsRoles: Readonly<Record<CmsRoleName, CmsRole>> = cms.roles

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


/**
 * Whether one of the CMS roles of `user` allows every action in `permissions`. A missing user, a user without a role,
 * and unknown roles are denied. It reads only `user.role`, so it needs no request.
 */
export function cmsCan(user: CmsUser | null | undefined, permissions: CmsPermissions): boolean {
  return cms.can(user, permissions)
}

/**
 * `defineContent({ authorize })` from the CMS roles: `content.can()` allows an action when a role of the user has
 * `content:<action>`. `defineContent({ extends: [cms, { roles: true }] })` uses it when the app sets no `authorize`.
 * Only CMS roles have `content:read`, so `/api/content/**` needs `defineContent({ access: "public" })` to serve visitors.
 */
export const cmsContentAuthorize: ContentAuthorize = ({ user, action }) => cmsCan(user, { content: [action] })

const commentPermissions: Readonly<Record<CommentsAuthorizeContext["action"], CmsStatements["comment"][number]>> = {
  read: "read",
  write: "create",
  resolve: "resolve",
  delete: "delete",
}

/**
 * `defineComments({ authorize })` from the CMS roles: `read` needs `comment:read`, `write` needs `comment:create`,
 * `resolve` needs `comment:resolve`, and deleting others' comments or threads needs `comment:delete`.
 */
export function cmsCommentsAuthorize(context: Pick<CommentsAuthorizeContext, "user" | "action">): boolean {
  if (!Object.hasOwn(commentPermissions, context.action)) return false
  return cmsCan(context.user, { comment: [commentPermissions[context.action]] })
}

/**
 * `defineConsoleAuthorize()` from the CMS roles. `admin` uses every Console section. Other roles use the `content`
 * section with `content:read-draft` and the `comments` section with `comment:read`. A user without either gets `403`.
 */
export function cmsConsoleAuthorize(context: { user?: CmsUser | null }): true | { sections: string[] } {
  if (cms.rolesOf(context.user).includes("admin")) return true
  const sections: string[] = []
  if (cmsCan(context.user, { content: ["read-draft"] })) sections.push("content")
  if (cmsCan(context.user, { comment: ["read"] })) sections.push("comments")
  return { sections }
}
