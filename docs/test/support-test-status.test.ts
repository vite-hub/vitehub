import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const supportMatrixPath = resolve(repoRoot, "docs/content/docs/frameworks-hosts/support-matrix.md");

describe("support matrix test status", () => {
  it("marks a primitive Live tested only when the live smoke calls it on that host", () => {
    const workflow = readFileSync(resolve(repoRoot, ".github/workflows/live-smoke.yml"), "utf8");
    const hosts = ["cloudflare", "vercel"] as const;
    const primitiveOfStep: Record<string, string> = { "DB": "Database", "Sandbox Task": "Sandbox" };
    const expected = new Set<string>();
    for (const step of workflow.split(/\n(?=\s+- name: )/)) {
      const name = /- name: (.+?) Live E2E/.exec(step)?.[1];
      if (!name) continue;
      const only = /if: matrix\.provider == '(\w+)'/.exec(step)?.[1];
      for (const host of hosts) {
        if (!only || only === host) expected.add(`${primitiveOfStep[name] ?? name}:${host}`);
      }
    }

    const page = readFileSync(supportMatrixPath, "utf8");
    const table = /<!-- support-matrix:test-status:start -->\n([\s\S]+?)\n<!-- support-matrix:test-status:end -->/.exec(page)?.[1];
    expect(table).toBeDefined();
    const [header, , ...rows] = table!.split("\n");
    expect(header).toBe("| Primitive | Cloudflare | Vercel |");
    const documented = new Set<string>();
    for (const row of rows) {
      const [primitive, ...cells] = row.split("|").slice(1, -1).map((cell) => cell.trim());
      cells.forEach((cell, index) => {
        if (cell === "Live tested") documented.add(`${primitive}:${hosts[index]}`);
      });
    }

    expect(expected.size).toBeGreaterThan(0);
    expect([...documented].sort()).toEqual([...expected].sort());
  });
});
