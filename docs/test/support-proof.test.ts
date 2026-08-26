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
    expect(supportProofPresentation(current, referenceNow).mark).toBe("✓");

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
      supportProofPresentation(supportProofFor("deployed-runtime", "cloudflare"), referenceNow),
    ).toMatchObject({ display: "Stopped at provision", mark: "!", state: "incomplete" });
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
    const liveRow = renderedRows.split("\n").find((line) => line.startsWith("| Live Smoke |"));
    expect(liveRow).toContain("Stopped at provision");
    expect(liveRow).not.toContain("✓");
  });

  it("makes the Vue matrix consume the same proof projection", () => {
    const component = readFileSync(
      resolve(repoRoot, "docs/app/components/SupportMatrix.vue"),
      "utf8",
    );

    expect(component).toContain('from "../data/support-proof"');
    for (const tier of supportProofTiers) {
      expect(component).toContain(`proofValues("${tier}")`);
    }
    expect(component).not.toContain('"available",\n            "The nightly Live Smoke deploys');
  });
});
