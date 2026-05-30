import { describe, expect, it } from "vitest";
import {
  createDocsPageState,
  getDocsPageFallback,
  resolveDocsRoute,
} from "../modules/vitehub-docs/runtime/utils/docs-rendering";
import { getDocsPageByPath } from "../modules/vitehub-docs/runtime/utils/docs";

describe("docs rendering state", () => {
  it("resolves unified docs routes without framework prefixes", () => {
    expect(resolveDocsRoute("/docs/server-primitives/kv")).toMatchObject({
      sourcePath: "/docs/server-primitives/kv",
      page: expect.objectContaining({ title: "KV" }),
    });
  });

  it("does not resolve removed framework docs routes", () => {
    expect(resolveDocsRoute("/docs/vite/kv")).toMatchObject({
      sourcePath: "/docs/vite/kv",
      page: null,
    });
  });

  it("creates a content page state without mutating the source document", () => {
    const page = getDocsPageByPath("/docs/server-primitives/kv");
    expect(page).toBeTruthy();

    const doc = { title: "Source", description: "Desc", meta: { order: 1 } };
    const state = createDocsPageState(doc, "/docs/server-primitives/kv", getDocsPageFallback(page!));

    expect(state).toMatchObject({
      path: "/docs/server-primitives/kv",
      title: "Source",
      description: "Desc",
      seo: { title: "Source", description: "Desc" },
      data: { order: 1 },
    });
    expect(doc).not.toHaveProperty("path");
  });
});
