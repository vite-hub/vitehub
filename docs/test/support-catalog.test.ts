import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { featureIds, featureSupport, impliedFeatures } from "@vite-hub/internal/features";
import type { FeatureId } from "@vite-hub/internal/features";
import { describe, expect, it } from "vitest";

import {
  renderSupportMatrixMarkdownTable,
  supportLevel,
  supportMatrixCatalogHosts,
  supportMatrixGroups,
} from "../app/data/support-matrix";

const catalogGroups = ["server-primitives", "application-features"] as const;
const rowFeatures: Record<string, FeatureId> = { "rate-limit": "rateLimit", sandbox: "sandboxTask" };
const supportPage = resolve(import.meta.dirname, "../content/docs/frameworks-hosts/support-matrix.md");

function catalogRows() {
  return supportMatrixGroups
    .filter((group) => catalogGroups.some((anchor) => anchor === group.anchor))
    .flatMap((group) => group.rows);
}

function generatedTable(page: string, anchor: string): string | undefined {
  const start = `<!-- support-matrix:${anchor}:start -->\n`;
  const end = `\n<!-- support-matrix:${anchor}:end -->`;
  const from = page.indexOf(start);
  const to = page.indexOf(end);
  return from === -1 || to === -1 ? undefined : page.slice(from + start.length, to);
}

describe("support matrix and feature catalog", () => {
  it("has one row for every catalog feature", () => {
    const ids = catalogRows().map((row) => rowFeatures[row.id] ?? row.id);
    expect(ids.sort()).toEqual([...featureIds].sort());
  });

  it("reads every catalog cell from the feature catalog", () => {
    for (const row of catalogRows()) {
      expect("values" in row, row.id).toBe(true);
      if (!("values" in row)) continue;
      const id = rowFeatures[row.id] ?? (row.id as FeatureId);
      for (const [column, host] of Object.entries(supportMatrixCatalogHosts)) {
        const support = featureSupport(id, host, "node");
        const cell = row.values[column as keyof typeof supportMatrixCatalogHosts];
        const requirements = impliedFeatures([id], host === "dev" ? "node" : host)
          .map((dependency) => featureSupport(dependency, host, "node"))
          .filter((dependency) => dependency.level !== "native");
        if (requirements.length && support.level !== "unsupported") {
          expect(cell.detail, `${id}:${host}`).toContain(support.detail);
          for (const requirement of requirements) {
            expect(cell.detail, `${id}:${host}`).toContain(requirement.detail);
          }
          continue;
        }
        expect(cell.status, `${id}:${host}`).toBe(supportLevel(support));
        expect(cell.detail, `${id}:${host}`).toBe(support.detail);
        expect(cell.display, `${id}:${host}`).toBe(support.level === "unsupported" ? "—" : support.display);
      }
    }
  });

  it.each(["comments", "connections", "console"])("qualifies %s with its hosted Database requirement", (id) => {
    const row = catalogRows().find((entry) => entry.id === id)!;
    expect("values" in row).toBe(true);
    if (!("values" in row)) return;
    for (const host of ["vercel", "netlify", "deno"] as const) {
      const cell = row.values[host];
      expect(cell.status, `${id}:${host}`).toBe("package");
      expect(cell.display, `${id}:${host}`).toContain("libSQL");
      expect(cell.detail, `${id}:${host}`).toContain("database.connection");
    }
    for (const host of ["local", "cloudflare", "node"] as const) {
      expect(row.values[host].status, `${id}:${host}`).toBe("available");
    }
  });

  it("keeps the Markdown tables of the support page generated from the matrix", () => {
    const page = readFileSync(supportPage, "utf8");
    for (const anchor of catalogGroups) {
      expect(generatedTable(page, anchor), anchor).toBe(renderSupportMatrixMarkdownTable(anchor));
    }
  });
});
