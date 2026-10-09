import { describe, expectTypeOf, it } from "vitest"

import * as view from "../src/sources/view.ts"

import type { WorkspaceSourceView, WorkspaceSourceWriteGrant } from "../src/sources/view.ts"

declare const sourceView: WorkspaceSourceView

describe("Source write grant mistakes", () => {
  it("requires a grant from assertWritable for each guarded write", async () => {
    const write = sourceView.requireWriteGrant(async (path, content: string) => `${path}:${content}`)
    const grant = await sourceView.assertWritable("notes/a.md")

    expectTypeOf(sourceView.assertWritable).returns.toEqualTypeOf<Promise<WorkspaceSourceWriteGrant>>()
    expectTypeOf(write(grant, "notes/a.md", "ok")).toEqualTypeOf<Promise<string>>()

    // @ts-expect-error A guarded write requires a grant.
    void write("notes/a.md", "ok")
    // @ts-expect-error A plain object with the same shape is not a grant.
    void write({ path: "notes/a.md" }, "notes/a.md", "ok")
    // @ts-expect-error The check is async. Its Promise is not a grant.
    void write(sourceView.assertWritable("notes/a.md"), "notes/a.md", "ok")
    // @ts-expect-error A grant does not let its holder change the bound path.
    grant.path = "docs/guide.md"
    // @ts-expect-error Only the Source view can create a grant.
    void new view.WorkspaceSourceWriteGrant("docs/guide.md")
  })
})
