import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  renderSupportProofMarkdownRows,
  resolveSupportProof,
  supportHosts,
  supportProofFor,
  supportProofLedger,
  supportProofPresentation,
  supportProofTiers,
  type SupportProofClaim,
} from "../app/data/support-proof";

const repoRoot = resolve(import.meta.dirname, "../..");
const supportMatrixPath = resolve(repoRoot, "docs/content/docs/frameworks-hosts/support-matrix.md");
const referenceNow = new Date("2026-08-27T00:00:00Z");

describe("support proof ledger", () => {
  it("contains one owned claim for every proof tier and host", () => {
    const expectedIds = supportProofTiers.flatMap((tier) =>
      supportHosts.map((host) => `${tier}:${host}`),
    );

    expect(supportProofLedger.map((claim) => claim.id)).toEqual(expectedIds);
    for (const claim of supportProofLedger) {
      expect(claim.owner.task || claim.owner.workflow, claim.id).not.toBeNull();
      for (const owner of [claim.owner.task, claim.owner.workflow]) {
        if (!owner) continue;
        const ownerPath = resolve(repoRoot, owner.path);
        expect(existsSync(ownerPath), `${claim.id}: ${owner.path}`).toBe(true);
        expect(readFileSync(ownerPath, "utf8"), `${claim.id}: ${owner.path}`).toContain(
          "name" in owner ? owner.name : `  ${owner.job}:`,
        );
      }
    }
  });

  it("only presents a fresh, completed success with a checkmark", () => {
    const current = supportProofFor("contract", "cloudflare");
    expect(resolveSupportProof(current, referenceNow)).toBe("current");
    expect(supportProofPresentation(current, referenceNow)).toMatchObject({
      evidence: {
        observedAt: "2026-08-26",
        url: "https://github.com/vite-hub/vitehub/actions/runs/32939970902",
      },
      mark: "✓",
    });

    expect(resolveSupportProof(current, new Date("2026-10-01T00:00:00Z"))).toBe("stale");
    expect(supportProofPresentation(current, new Date("2026-10-01T00:00:00Z"))).toMatchObject({
      mark: "◷",
      state: "stale",
    });
    expect(resolveSupportProof(current, new Date("2026-08-25T00:00:00Z"))).toBe("stale");

    const stageIncompleteSuccess: SupportProofClaim = {
      ...supportProofFor("deployed-runtime", "cloudflare"),
      evidence: { ...current.evidence },
      lastLiveSmokeStage: "deploy",
    };
    expect(supportProofPresentation(stageIncompleteSuccess, referenceNow)).toMatchObject({
      mark: "!",
      state: "incomplete",
    });
  });

  it("classifies failed, unpublished, and inapplicable evidence without success marks", () => {
    expect(
      supportProofPresentation(supportProofFor("deployed-runtime", "vercel"), referenceNow),
    ).toMatchObject({ display: "Failed", mark: "!", state: "failed" });
    expect(
      supportProofPresentation(supportProofFor("deployed-runtime", "netlify"), referenceNow),
    ).toMatchObject({ mark: "—", state: "unpublished" });
    expect(
      supportProofPresentation(supportProofFor("deployed-runtime", "local"), referenceNow),
    ).toMatchObject({ mark: "—", state: "not-applicable" });
  });

  it("keeps the public Markdown projection synchronized with the ledger", () => {
    const matrix = readFileSync(supportMatrixPath, "utf8");
    const labels = [
      "Generated Provider Output",
      "Contract tests",
      "Local Provider Run",
      "Live Smoke",
    ];
    const renderedRows = matrix
      .split("\n")
      .filter((line) => labels.some((label) => line.startsWith(`| ${label} |`)))
      .join("\n");

    expect(renderedRows).toBe(renderSupportProofMarkdownRows());
    expect(renderedRows).toContain("last observed 2026-08-26; stale after 30 days");
    expect(renderedRows).not.toContain("✓");
    const liveRow = renderedRows.split("\n").find((line) => line.startsWith("| Live Smoke |"));
    expect(liveRow).toContain("last observed 2026-10-31; stale after 2 days");
    expect(liveRow).toContain("**Failed** [Evidence](");
    expect(liveRow).not.toContain("Stopped at provision");
  });

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

  it("makes the Vue matrix consume the same proof projection", () => {
    const component = readFileSync(
      resolve(repoRoot, "docs/app/components/content/SupportMatrix.vue"),
      "utf8",
    );
    const data = readFileSync(resolve(repoRoot, "docs/app/data/support-matrix.ts"), "utf8");

    expect(component).toContain('from "../../data/support-proof"');
    expect(component).toContain('useState("support-proof-observed-at"');
    expect(component).toContain("supportProofPresentation(supportProofFor(row.proof, host.id), now)");
    expect(component).toContain("scheduleProofRefresh");
    expect(component).toContain(':href="cell.evidence.url"');
    for (const tier of supportProofTiers) {
      expect(data).toContain(`proof: "${tier}"`);
    }
    expect(data).not.toContain("The nightly Live Smoke deploys");
  });

  it("refreshes the time-sensitive proof ages after a prerender", () => {
    const matrix = readFileSync(resolve(repoRoot, "docs/app/components/content/SupportMatrix.vue"), "utf8");

    // The build prerenders every docs page, the matrix included. The browser recomputes the ages when it mounts.
    expect(matrix).toMatch(/onMounted\(\(\) => \{\s*proofObservedAt\.value = new Date\(\)\.toISOString\(\);\s*scheduleProofRefresh\(\);/);
  });
});
