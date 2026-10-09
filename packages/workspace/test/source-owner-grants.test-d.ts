import { describe, expectTypeOf, it } from "vitest"

import * as mountGrants from "../src/sources/mount-grants.ts"

import type { WorkspaceStore } from "../src/core/types.ts"
import type { WorkspaceSourceMountGrant } from "../src/sources/mount-grants.ts"
import type { WorkspaceSourceView, WorkspaceSourceWriteGrant } from "../src/sources/view.ts"

declare const authority: ReturnType<typeof mountGrants.createWorkspaceSourceMountAuthority>
declare const sourceView: WorkspaceSourceView
declare const store: WorkspaceStore

describe("Source owner grant mistakes", () => {
  it("requires a mount grant from an owner authority", () => {
    const grant = authority.grant({ key: "docs", mountPath: "docs" })

    expectTypeOf(grant).toEqualTypeOf<WorkspaceSourceMountGrant>()
    expectTypeOf(authority.store(grant, store)).toEqualTypeOf<WorkspaceStore>()

    // @ts-expect-error A Source mount Store requires a grant.
    void authority.store(store)
    // @ts-expect-error A plain object with the same shape is not a grant.
    void authority.store({ mountPath: "docs", source: "docs" }, store)
    // @ts-expect-error A Source write grant is not a Source mount grant.
    void authority.store({} as WorkspaceSourceWriteGrant, store)
    // @ts-expect-error A grant does not let its holder change the bound mount.
    grant.mountPath = ""
    // @ts-expect-error Only an owner authority can create a grant.
    void new mountGrants.WorkspaceSourceMountGrant("docs", "")
  })

  it("requires Source write grants for takeRemote paths", async () => {
    const rebase = sourceView.requireRebaseGrants(async () => {})
    const grant = await sourceView.assertWritable("notes/a.md")

    expectTypeOf(rebase([grant], { takeRemote: ["notes/a.md"] })).toEqualTypeOf<Promise<void>>()

    // @ts-expect-error A rebase requires grants for its takeRemote paths.
    void rebase({ takeRemote: ["notes/a.md"] })
    // @ts-expect-error Path strings are not grants.
    void rebase(["notes/a.md"], { takeRemote: ["notes/a.md"] })
    // @ts-expect-error A Source mount grant is not a Source write grant.
    void rebase([authority.grant({ key: "docs", mountPath: "docs" })], { takeRemote: ["docs"] })
    // @ts-expect-error The check is async. Its Promise is not a grant.
    void rebase([sourceView.assertWritable("notes/a.md")], { takeRemote: ["notes/a.md"] })
  })
})
