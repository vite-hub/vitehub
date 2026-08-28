export const supportHosts = [
  "local",
  "cloudflare",
  "vercel",
  "netlify",
  "deno",
  "nitro",
  "node",
] as const;

export const supportProofTiers = [
  "contract",
  "generated-output",
  "local-provider-run",
  "deployed-runtime",
] as const;

export type SupportHost = (typeof supportHosts)[number];
export type SupportProofTier = (typeof supportProofTiers)[number];
export type SupportProofState =
  | "current"
  | "stale"
  | "incomplete"
  | "failed"
  | "unpublished"
  | "not-applicable";

type LiveSmokeStage = "preflight" | "provision" | "build" | "deploy" | "runtime";
type EvidenceConclusion = "success" | "failure" | "not-published" | "not-applicable";

type ProofOwner = {
  task: { name: string; path: string } | null;
  workflow: { job: string; path: string } | null;
};

type ProofEvidence = {
  conclusion: EvidenceConclusion;
  observedAt: string | null;
  url: string | null;
};

export type SupportProofClaim = {
  claim: string;
  evidence: ProofEvidence;
  freshness: { maxAgeDays: number | null };
  host: SupportHost;
  id: `${SupportProofTier}:${SupportHost}`;
  lastLiveSmokeStage: LiveSmokeStage | null;
  owner: ProofOwner;
  tier: SupportProofTier;
};

export type SupportProofPresentation = {
  detail: string;
  display?: string;
  evidence?: {
    observedAt: string;
    url: string;
  };
  label: string;
  mark: "✓" | "◷" | "!" | "—";
  state: SupportProofState;
};

type ClaimDefinition = Omit<SupportProofClaim, "host" | "id" | "tier">;

const currentCiEvidence = {
  conclusion: "success",
  observedAt: "2026-08-26T07:05:47Z",
  url: "https://github.com/vite-hub/vitehub/actions/runs/32939970902",
} as const satisfies ProofEvidence;

const failedLiveEvidence = {
  conclusion: "failure",
  observedAt: "2026-08-26T04:09:44Z",
  url: "https://github.com/vite-hub/vitehub/actions/runs/32928943031",
} as const satisfies ProofEvidence;

const notPublished = {
  conclusion: "not-published",
  observedAt: null,
  url: null,
} as const satisfies ProofEvidence;

const notApplicable = {
  conclusion: "not-applicable",
  observedAt: null,
  url: null,
} as const satisfies ProofEvidence;

const contractOwner: ProofOwner = {
  task: { name: "test:contracts", path: "test/tasks.ts" },
  workflow: { job: "ci", path: ".github/workflows/ci.yml" },
};

const docsOwner: ProofOwner = {
  task: { name: "test", path: "docs/package.json" },
  workflow: { job: "ci", path: ".github/workflows/ci.yml" },
};

const liveSmokeOwner: ProofOwner = {
  task: null,
  workflow: { job: "live-smoke", path: ".github/workflows/live-smoke.yml" },
};

function ciClaim(claim: string, owner: ProofOwner = contractOwner): ClaimDefinition {
  return {
    claim,
    evidence: currentCiEvidence,
    freshness: { maxAgeDays: 30 },
    lastLiveSmokeStage: null,
    owner,
  };
}

function unpublishedClaim(claim: string): ClaimDefinition {
  return {
    claim,
    evidence: notPublished,
    freshness: { maxAgeDays: null },
    lastLiveSmokeStage: null,
    owner: docsOwner,
  };
}

function inapplicableClaim(claim: string): ClaimDefinition {
  return {
    claim,
    evidence: notApplicable,
    freshness: { maxAgeDays: null },
    lastLiveSmokeStage: null,
    owner: docsOwner,
  };
}

const claimDefinitions = {
  contract: {
    local: ciClaim("Package and documentation CI assert local Runtime Helper contracts."),
    cloudflare: ciClaim(
      "Owning packages assert Cloudflare runtime and generated-output contracts.",
    ),
    vercel: ciClaim("Owning packages assert Vercel runtime and generated-output contracts."),
    netlify: ciClaim("Agent, Schedule, and the Netlify fixture have contract coverage."),
    deno: ciClaim("Agent and Schedule package tests assert Deno output."),
    nitro: ciClaim("Owning packages test their Nitro integration boundaries."),
    node: ciClaim("Owning packages test their Node-compatible drivers and handlers."),
  },
  "generated-output": {
    local: inapplicableClaim(
      "Local Vite is not a generated deployment target. A local build can still target a hosted provider.",
    ),
    cloudflare: ciClaim(
      "Enabled integrations compose a Worker, wrangler.json, bindings, callbacks, and runtime modules.",
      {
        task: { name: "test:output:cloudflare", path: "test/tasks.ts" },
        workflow: { job: "verify-providers", path: ".github/workflows/ci.yml" },
      },
    ),
    vercel: ciClaim(
      "Enabled integrations write Vercel Build Output, functions, routes, cron entries, and runtime modules.",
      {
        task: { name: "test:output:vercel", path: "test/tasks.ts" },
        workflow: { job: "verify-providers", path: ".github/workflows/ci.yml" },
      },
    ),
    netlify: ciClaim("Agent and Schedule write functions under .netlify/v1/functions.", {
      task: { name: "e2e:netlify", path: "vite.config.ts" },
      workflow: { job: "verify-providers", path: ".github/workflows/ci.yml" },
    }),
    deno: ciClaim(
      "Agent and Schedule write Deno entrypoints. ViteHub does not generate one general Deno bundle.",
    ),
    nitro: ciClaim(
      "Package integrations generate Nitro handlers, plugins, or configuration where documented.",
    ),
    node: inapplicableClaim("ViteHub does not emit one unified Node deployment bundle."),
  },
  "local-provider-run": {
    local: inapplicableClaim("The Local Vite row makes no hosted-provider proof claim."),
    cloudflare: ciClaim(
      "Pull requests run the shared primitive playground against local Cloudflare output.",
      {
        task: { name: "e2e:local", path: "vite.config.ts" },
        workflow: { job: "verify-providers", path: ".github/workflows/ci.yml" },
      },
    ),
    vercel: ciClaim(
      "Pull requests run the shared primitive playground against local Vercel adapters.",
      {
        task: { name: "e2e:local", path: "vite.config.ts" },
        workflow: { job: "verify-providers", path: ".github/workflows/ci.yml" },
      },
    ),
    netlify: ciClaim("CI runs a real-project fixture through Netlify CLI.", {
      task: { name: "e2e:netlify", path: "vite.config.ts" },
      workflow: { job: "verify-providers", path: ".github/workflows/ci.yml" },
    }),
    deno: unpublishedClaim("ViteHub does not publish one shared local Deno provider run."),
    nitro: unpublishedClaim("ViteHub does not publish one unified local Nitro matrix run."),
    node: unpublishedClaim("ViteHub does not publish one self-hosted deployment suite."),
  },
  "deployed-runtime": {
    local: inapplicableClaim("Local Vite is not a hosted deployment target."),
    cloudflare: {
      claim:
        "The nightly Live Smoke targets nine primitives, including Rate Limit. Browser and Agent routes are outside this run.",
      evidence: failedLiveEvidence,
      freshness: { maxAgeDays: 2 },
      lastLiveSmokeStage: "provision",
      owner: liveSmokeOwner,
    },
    vercel: {
      claim:
        "The nightly Live Smoke targets eight primitives. ViteHub has no native Vercel Rate Limit driver, and Agent routes are outside this run.",
      evidence: failedLiveEvidence,
      freshness: { maxAgeDays: 2 },
      lastLiveSmokeStage: "provision",
      owner: liveSmokeOwner,
    },
    netlify: unpublishedClaim("Live proof is not published for Netlify."),
    deno: unpublishedClaim("Live proof is not published for Deno."),
    nitro: unpublishedClaim("Live proof is not published as one unified Nitro matrix."),
    node: unpublishedClaim("Live proof is not published as one self-hosted deployment suite."),
  },
} satisfies Record<SupportProofTier, Record<SupportHost, ClaimDefinition>>;

export const supportProofLedger: readonly SupportProofClaim[] = supportProofTiers.flatMap((tier) =>
  supportHosts.map((host) => ({
    ...claimDefinitions[tier][host],
    host,
    id: `${tier}:${host}` as const,
    tier,
  })),
);

const proofById = new Map(supportProofLedger.map((claim) => [claim.id, claim]));

export function supportProofFor(tier: SupportProofTier, host: SupportHost): SupportProofClaim {
  const claim = proofById.get(`${tier}:${host}`);
  if (!claim) throw new Error(`Missing support proof for ${tier}:${host}`);
  return claim;
}

export function resolveSupportProof(
  claim: SupportProofClaim,
  now: Date = new Date(),
): SupportProofState {
  if (claim.evidence.conclusion === "not-applicable") return "not-applicable";
  if (claim.evidence.conclusion === "not-published") return "unpublished";
  if (claim.evidence.conclusion === "failure") {
    return claim.tier === "deployed-runtime" && claim.lastLiveSmokeStage !== "runtime"
      ? "incomplete"
      : "failed";
  }
  if (claim.tier === "deployed-runtime" && claim.lastLiveSmokeStage !== "runtime") {
    return "incomplete";
  }

  const observedAt = Date.parse(claim.evidence.observedAt ?? "");
  const maxAgeDays = claim.freshness.maxAgeDays;
  if (!Number.isFinite(observedAt) || maxAgeDays === null) return "stale";
  const age = now.getTime() - observedAt;
  return age < 0 || age > maxAgeDays * 86_400_000 ? "stale" : "current";
}

export function supportProofPresentation(
  claim: SupportProofClaim,
  now: Date = new Date(),
): SupportProofPresentation {
  const state = resolveSupportProof(claim, now);
  const stage = claim.lastLiveSmokeStage;
  const observed = claim.evidence.observedAt?.slice(0, 10);
  const evidence =
    observed && claim.evidence.url ? { observedAt: observed, url: claim.evidence.url } : undefined;
  const metadata: Record<SupportProofState, Omit<SupportProofPresentation, "detail" | "state">> = {
    current: { display: "Current", label: "Current proof", mark: "✓" },
    stale: { display: "Stale", label: "Stale proof", mark: "◷" },
    incomplete: {
      display: stage ? `Stopped at ${stage}` : "Incomplete",
      label: "Stage-incomplete proof",
      mark: "!",
    },
    failed: { display: "Failed", label: "Failed proof", mark: "!" },
    unpublished: { display: "Not published", label: "Proof not published", mark: "—" },
    "not-applicable": { label: "Not applicable", mark: "—" },
  };

  return { ...metadata[state], detail: claim.claim, evidence, state };
}

const markdownTiers: readonly [string, SupportProofTier][] = [
  ["Generated Provider Output", "generated-output"],
  ["Contract tests", "contract"],
  ["Local Provider Run", "local-provider-run"],
  ["Live Smoke", "deployed-runtime"],
];

export function renderSupportProofMarkdownRows(): string {
  return markdownTiers
    .map(([label, tier]) => {
      const cells = supportHosts.map((host) => {
        const claim = supportProofFor(tier, host);
        const presentation = supportProofPresentation(claim);
        if (!claim.evidence.url || !claim.evidence.observedAt) {
          return presentation.state === "not-applicable" ? "—" : `**${presentation.display}**`;
        }
        const maxAgeDays = claim.freshness.maxAgeDays;
        return `[Evidence](${claim.evidence.url}) (${claim.evidence.observedAt.slice(0, 10)}${maxAgeDays === null ? "" : `; ${maxAgeDays}-day freshness window`})`;
      });
      return `| ${label} | ${cells.join(" | ")} |`;
    })
    .join("\n");
}

function assertCompleteLedger(): void {
  const expectedIds: SupportProofClaim["id"][] = supportProofTiers.flatMap((tier) =>
    supportHosts.map((host) => `${tier}:${host}` as const),
  );
  if (
    supportProofLedger.length !== expectedIds.length ||
    new Set(proofById.keys()).size !== expectedIds.length
  ) {
    throw new Error("Support proof ledger must contain one unique claim per tier and host");
  }
  for (const id of expectedIds) {
    const claim = proofById.get(id);
    if (!claim) throw new Error(`Support proof ledger is missing ${id}`);
    if (!claim.owner.task && !claim.owner.workflow) throw new Error(`${id} has no proof owner`);
    const hasEvidence =
      claim.evidence.conclusion === "success" || claim.evidence.conclusion === "failure";
    if (hasEvidence !== Boolean(claim.evidence.observedAt && claim.evidence.url)) {
      throw new Error(`${id} has inconsistent evidence metadata`);
    }
    if (hasEvidence && claim.freshness.maxAgeDays === null) {
      throw new Error(`${id} has evidence without a freshness limit`);
    }
  }
}

assertCompleteLedger();
