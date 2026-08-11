import { describe, expect, it } from "vitest";
import { docsManifest, getDocsPageByPath } from "../modules/vitehub-docs/runtime/utils/docs";
import {
  getDocsLaneSelectionTarget,
  getDocsSectionsForLane,
  resolveDocsLane,
} from "../modules/vitehub-docs/runtime/utils/docs-navigation";

describe("docs lane navigation", () => {
  it("lets route-owned lanes override query and persisted state", () => {
    const page = getDocsPageByPath("/docs/server-primitives/kv");

    expect(resolveDocsLane({
      path: "/docs/server-primitives/kv",
      page,
      queryLane: "agents",
      persistedLane: "agents",
    })).toBe("server-primitives");
  });

  it("uses page metadata before persisted state for mixed sections", () => {
    const page = getDocsPageByPath("/docs/concepts/agent-invocations");

    expect(resolveDocsLane({
      path: page!.path,
      page,
      persistedLane: "server-primitives",
    })).toBe("agents");
  });

  it("uses the query to preserve lane context on shared pages", () => {
    const page = getDocsPageByPath("/docs/concepts");

    expect(resolveDocsLane({
      path: page!.path,
      page,
      queryLane: "server-primitives",
      persistedLane: "agents",
    })).toBe("server-primitives");
  });

  it("filters product sections and mixed pages through the manifest", () => {
    const agents = getDocsSectionsForLane(docsManifest.sections, "agents");
    const primitives = getDocsSectionsForLane(docsManifest.sections, "server-primitives");

    expect(agents.map(section => section.id)).toContain("agents");
    expect(agents.map(section => section.id)).not.toContain("server-primitives");
    expect(primitives.map(section => section.id)).toContain("server-primitives");
    expect(primitives.map(section => section.id)).not.toContain("agents");
    expect(agents.find(section => section.id === "getting-started")?.pages.map(page => page.id)).not.toContain("first-server-primitive");
    expect(primitives.find(section => section.id === "getting-started")?.pages.map(page => page.id)).not.toContain("first-agent");
  });

  it("persists in-place lane selections without navigating exclusive pages", () => {
    const sharedPage = getDocsPageByPath("/docs/concepts");
    const agentPage = getDocsPageByPath("/docs/agents/invocations");

    expect(getDocsLaneSelectionTarget({
      hash: "#runtime",
      lane: "server-primitives",
      page: null,
      path: "/docs",
      query: { source: "test" },
    })).toEqual({
      hash: "#runtime",
      path: "/docs",
      query: { source: "test", lane: "server-primitives" },
    });
    expect(getDocsLaneSelectionTarget({
      hash: "#runtime",
      lane: "server-primitives",
      page: sharedPage,
      path: sharedPage!.path,
      query: { lane: "agents", source: "test" },
    })).toEqual({
      hash: "#runtime",
      path: "/docs/concepts",
      query: { lane: "server-primitives", source: "test" },
    });
    expect(getDocsLaneSelectionTarget({
      lane: "server-primitives",
      page: agentPage,
      path: agentPage!.path,
    })).toBeNull();
  });
});
