import { describe, expect, it } from "vitest";

// The docs app reads the catalog from source until the matrix is generated from it.
import type { FeatureHost, FeatureId, HostSupport } from "../../packages/internal/src/features.ts";
import { featureSupport } from "../../packages/internal/src/features.ts";
import { supportMatrixGroups } from "../app/data/support-matrix";
import type { SupportLevel } from "../app/data/support-matrix";

const rowFeatures: Record<string, FeatureId> = { "rate-limit": "rateLimit", sandbox: "sandboxTask" };
const columnHosts: Record<string, FeatureHost> = {
  cloudflare: "cloudflare",
  deno: "deno",
  local: "dev",
  netlify: "netlify",
  node: "node",
  vercel: "vercel",
};

/**
 * Cells where the docs matrix and the feature catalog disagree. The catalog describes what `vitehub({...})` does.
 * Each entry says why the cell differs, so a fix in either place removes the entry.
 */
const knownDrift: Record<string, string> = {
  "browser:dev": "The docs describe localBrowser() from code. Browser Definitions through vitehub() need the Cloudflare preset.",
  "browser:node": "The docs describe localBrowser() from code. vitehub() rejects browser on the Node preset.",
  "queue:netlify": "The docs describe an explicit Queue Provider. `queue` in vitehub() is a boolean with no provider option.",
  "realtime:node": "The docs mark memory as local. The app must set realtime.authority to \"memory\" for a build.",
  "sandboxTask:dev": "The docs say the provider is selected explicitly. Development runs the provider of the preset.",
  "sandboxTask:netlify": "The docs describe an explicit Vercel Sandbox. vitehub() turns sandboxTask off where the preset has no Sandbox.",
  "sandboxTask:node": "The docs describe an explicit provider. vitehub() turns sandboxTask off where the preset has no Sandbox.",
  "schedule:deno": "The docs describe the standalone Deno.cron integration. vitehub() rejects schedule on the Deno preset.",
  "workflow:deno": "The docs describe explicit OpenWorkflow. The owner resolver defaults Deno hosting to Vercel Workflow.",
  "workflow:dev": "The docs describe OpenWorkflow. The default Node preset selects Vercel Workflow unless OpenWorkflow storage is configured.",
  "workflow:node": "The docs describe OpenWorkflow. Node hosting defaults to Vercel Workflow unless OpenWorkflow storage is configured.",
  "workspace:cloudflare": "The default store is memory in the Worker isolate. Durable state needs an explicit Artifacts or GitHub store.",
  "workspace:vercel": "The default store is process-local memory without BLOB_READ_WRITE_TOKEN. A Blob token selects durable Vercel Blob storage.",
};

function docsLevel(support: HostSupport): SupportLevel {
  if (support.level === "native") return support.guarantee === "process-local" ? "local" : "available";
  return support.level === "explicit" ? "package" : "none";
}

function docsDisplay(support: HostSupport): string {
  return support.level === "unsupported" ? "—" : support.display;
}

describe("support matrix and feature catalog", () => {
  it("maps every primitive cell of the docs matrix to the catalog", () => {
    const group = supportMatrixGroups.find(entry => entry.anchor === "server-primitives");
    expect(group).toBeDefined();
    const drift: string[] = [];
    for (const row of group!.rows) {
      if (!("values" in row)) continue;
      const id = rowFeatures[row.id] ?? (row.id as FeatureId);
      for (const [column, host] of Object.entries(columnHosts)) {
        const cell = row.values[column as keyof typeof row.values];
        const support = featureSupport(id, host);
        if (docsLevel(support) !== cell.status || docsDisplay(support) !== (cell.display ?? "—")) drift.push(`${id}:${host}`);
      }
    }
    expect(drift.sort()).toEqual(Object.keys(knownDrift).sort());
  });
});
