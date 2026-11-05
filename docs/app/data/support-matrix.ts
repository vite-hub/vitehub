import { featureSupport, features } from "@vite-hub/internal/features";
import type { FeatureHost, FeatureId, HostSupport } from "@vite-hub/internal/features";

import { supportHosts } from "./support-proof";
import type { SupportHost, SupportProofState, SupportProofTier } from "./support-proof";

/** How a host supports a contract. Proof rows use the states of the proof ledger instead. */
export type SupportLevel = "available" | "package" | "local" | "none";
export type SupportMatrixStatus = SupportLevel | SupportProofState;

export type SupportMatrixCell = {
  detail: string;
  /** The provider or adapter that the host uses, such as `R2`. */
  display?: string;
  status: SupportLevel;
};

export type SupportMatrixHost = {
  icon: string;
  id: SupportHost;
  label: string;
  to?: string;
};

export type SupportMatrixRow = {
  description: string;
  id: string;
  label: string;
} & (
  | { values: Record<SupportHost, SupportMatrixCell> }
  /** Proof rows read their cells from the proof ledger, because their state changes with time. */
  | { proof: SupportProofTier }
);

export type SupportMatrixGroup = {
  anchor?: string;
  label: string;
  rows: SupportMatrixRow[];
};

export const supportMatrixHosts: SupportMatrixHost[] = [
  { id: "local", label: "Local Vite", icon: "i-simple-icons-vite" },
  {
    id: "cloudflare",
    label: "Cloudflare",
    icon: "i-simple-icons-cloudflare",
    to: "/docs/frameworks-hosts/cloudflare",
  },
  {
    id: "vercel",
    label: "Vercel",
    icon: "i-simple-icons-vercel",
    to: "/docs/frameworks-hosts/vercel",
  },
  {
    id: "netlify",
    label: "Netlify",
    icon: "i-simple-icons-netlify",
    to: "/docs/frameworks-hosts/netlify",
  },
  {
    id: "deno",
    label: "Deno",
    icon: "i-simple-icons-deno",
    to: "/docs/frameworks-hosts/deno",
  },
  {
    id: "nitro",
    label: "Nitro / UnJS",
    icon: "i-unjs-nitro-mark",
    to: "/docs/frameworks-hosts/nitro-unjs",
  },
  {
    id: "node",
    label: "Node / self-hosted",
    icon: "i-simple-icons-nodedotjs",
    to: "/docs/frameworks-hosts/node-self-hosted",
  },
];

const cell = (status: SupportLevel, detail: string, display?: string): SupportMatrixCell => ({
  detail,
  display,
  status,
});

/** The catalog host of each column. Nitro is not a ViteHub preset, so its cells are written by hand. */
export const supportMatrixCatalogHosts: Record<Exclude<SupportHost, "nitro">, FeatureHost> = {
  local: "dev",
  cloudflare: "cloudflare",
  vercel: "vercel",
  netlify: "netlify",
  deno: "deno",
  node: "node",
};

/** The docs level of a catalog cell. An `explicit` provider choice is package-specific support. */
export function supportLevel(support: HostSupport): SupportLevel {
  if (support.level === "native") return support.guarantee === "process-local" ? "local" : "available";
  return support.level === "explicit" ? "package" : "none";
}

function catalogCell(support: HostSupport): SupportMatrixCell {
  const display = support.level === "unsupported" ? "—" : support.display;
  return cell(supportLevel(support), support.detail, display);
}

/** A row whose cells come from the feature catalog, except the hand-written `nitro` cell. */
function featureRow(
  feature: FeatureId,
  description: string,
  nitro: SupportMatrixCell,
  id: string = feature,
): SupportMatrixRow {
  const catalog = (host: keyof typeof supportMatrixCatalogHosts) =>
    catalogCell(featureSupport(feature, supportMatrixCatalogHosts[host]));
  return {
    description,
    id,
    label: features[feature].title,
    values: {
      local: catalog("local"),
      cloudflare: catalog("cloudflare"),
      vercel: catalog("vercel"),
      netlify: catalog("netlify"),
      deno: catalog("deno"),
      nitro,
      node: catalog("node"),
    },
  };
}

const serverPrimitives: SupportMatrixGroup = {
  anchor: "server-primitives",
  label: "Server primitives",
  rows: [
    featureRow("browser", "Provider-backed browser operations", cell(
      "none",
      "Browser Definitions require ViteHub's Cloudflare preset, not a generic Nitro preset.",
      "—",
    )),
    featureRow("blob", "Object storage", cell(
      "package",
      "Uses the Blob driver selected for the deployment host.",
      "Host driver",
    )),
    featureRow("cache", "Nitro cache storage", cell(
      "package",
      "Uses the cache driver selected for the deployment host.",
      "Host driver",
    )),
    featureRow("database", "Named SQL databases", cell(
      "available",
      "Nuxt can wire one Cloudflare D1 host resource for Nuxt Content and Nitro.",
      "Nuxt D1",
    )),
    featureRow("email", "Transactional email delivery", cell(
      "package",
      "Uses the explicit ViteHub Email driver selected for the deployment host.",
      "Host driver",
    )),
    featureRow("kv", "Key-value storage", cell(
      "package",
      "Uses the KV driver selected for the deployment host.",
      "Host driver",
    )),
    featureRow("queue", "Message delivery", cell(
      "package",
      "Cloudflare Queue bindings or the Vercel Queues runtime client can be composed through Nitro output.",
      "Cloudflare / Vercel",
    )),
    featureRow("rateLimit", "Atomic request budgets", cell(
      "package",
      "Cloudflare Nitro presets infer the Cloudflare binding.",
      "Cloudflare",
    ), "rate-limit"),
    featureRow("realtime", "Authoritative collaborative rooms", cell(
      "package",
      "Cloudflare Nitro output uses Durable Objects. A single-process Node server can select memory explicitly.",
      "Host authority",
    )),
    featureRow("sandboxTask", "Isolated command execution", cell(
      "package",
      "Uses Cloudflare Sandbox or Vercel Sandbox when selected by the Nitro host.",
      "Cloudflare / Vercel",
    ), "sandbox"),
    featureRow("schedule", "Static and runtime schedules", cell(
      "available",
      "Nitro Provider Wake, or the process runtime on a long-lived host.",
      "Provider Wake",
    )),
    featureRow("workflow", "Durable execution", cell(
      "package",
      "Uses the Workflow provider selected for the deployment host.",
      "Host provider",
    )),
    featureRow("workspace", "Agent file-tree state", cell(
      "package",
      "Runtime setup uses the Workspace Store selected for the host.",
      "Host store",
    )),
  ],
};

const applicationFeatures: SupportMatrixGroup = {
  anchor: "application-features",
  label: "Agents and app features",
  rows: [
    featureRow("agent", "Agents with tools and Capabilities", cell(
      "package",
      "Agent chat and webhook routes run through generated Nitro handlers.",
      "Agent routes",
    )),
    featureRow("auth", "Sign-in, sessions, and organizations", cell(
      "package",
      "The Auth route runs through a generated Nitro handler.",
      "Auth route",
    )),
    featureRow("channels", "Chat messages delivered to Agents", cell(
      "package",
      "Channel webhooks run through the generated Agent routes.",
      "Agent routes",
    )),
    featureRow("comments", "Comments on app pages", cell(
      "package",
      "Comments use the Database selected for the deployment host.",
      "Host database",
    )),
    featureRow("connections", "OAuth and API key grants", cell(
      "package",
      "Connection grants use the Database selected for the deployment host.",
      "Host database",
    )),
    featureRow("console", "Inspection and operations UI", cell(
      "package",
      "The Console routes run in the Nitro output of the selected preset.",
      "Nitro routes",
    )),
    featureRow("env", "Typed variables and secrets", cell(
      "package",
      "Variables are validated at build and in the Nitro output of the selected preset.",
      "Nitro runtime",
    )),
    featureRow("logs", "Log sources and the development buffer", cell(
      "package",
      "Logs read the log source that the app configures for the deployment host.",
      "Host source",
    )),
    featureRow("observability", "Agent telemetry and request logs", cell(
      "package",
      "Evlog runs in the Nitro output of the selected preset.",
      "Evlog",
    )),
  ],
};

export const supportMatrixGroups: SupportMatrixGroup[] = [
  {
    label: "Runtime",
    rows: [
      {
        id: "runtime-helpers",
        label: "Runtime helpers",
        description: "Application imports and handlers",
        values: {
          local: cell(
            "available",
            "Active package integrations expose their application imports and generated registries.",
          ),
          cloudflare: cell(
            "package",
            "Blob, Database, KV, Queue, Rate Limit, Sandbox, Schedule, Workflow, and Workspace run in the live playground. Browser and Agent add package-owned support.",
          ),
          vercel: cell(
            "package",
            "Blob, Database, KV, Queue, Sandbox, Schedule, Workflow, and Workspace run in the live playground. Agent routes have separate package output.",
          ),
          netlify: cell(
            "package",
            "Blob uses netlify-blobs. Agent HTTP routes and static Schedules have generated function output.",
          ),
          deno: cell(
            "package",
            "Agent chat and webhook routes, static Schedule wake output, and KV with deno-kv are supported.",
          ),
          nitro: cell(
            "package",
            "Auth and Agent handlers, the Schedule Nitro bridge, Workspace runtime setup, and Database Nuxt D1 wiring are supported.",
          ),
          node: cell(
            "package",
            "Server APIs and handlers run when their selected driver supports Node.",
          ),
        },
      },
      {
        id: "local-providers",
        label: "Local providers",
        description: "State and execution without a cloud account",
        values: {
          local: cell(
            "available",
            "Blob fs, KV fs-lite, Rate Limit memory, and Workspace local or memory cover common local state.",
          ),
          cloudflare: cell(
            "package",
            "Pull requests build Cloudflare output and run the primitive playground locally. Browser has output contract tests.",
          ),
          vercel: cell(
            "package",
            "Pull requests build Vercel output and run the primitive playground against local service adapters.",
          ),
          netlify: cell("package", "CI runs the real-project fixture through Netlify CLI."),
          deno: cell(
            "package",
            "deno-kv and generated Agent or Schedule output run locally with the documented Deno permissions.",
          ),
          nitro: cell(
            "none",
            "Nitro is host integration glue, not a ViteHub storage or execution provider.",
          ),
          node: cell(
            "local",
            "Blob fs, KV fs-lite, Rate Limit memory, and Workspace local or memory are single-process development providers.",
          ),
        },
      },
    ],
  },
  serverPrimitives,
  applicationFeatures,
  {
    anchor: "deployment-and-proof",
    label: "Output",
    rows: [
      {
        id: "provider-output",
        label: "Provider output",
        description: "Generated deployment files",
        proof: "generated-output",
      },
      {
        id: "provisioning",
        label: "Provisioning",
        description: "Resources ViteHub can create",
        values: {
          local: cell("none", "Local providers do not need hosted resource provisioning."),
          cloudflare: cell(
            "package",
            "ViteHub can provision R2 buckets, D1 databases, KV namespaces, and Cloudflare Queues.",
          ),
          vercel: cell(
            "package",
            "ViteHub can create a Blob store and configure the project environment with VERCEL_TOKEN and VERCEL_PROJECT_ID.",
          ),
          netlify: cell("none", "ViteHub does not provide Netlify provisioning."),
          deno: cell("none", "ViteHub does not provide Deno provisioning."),
          nitro: cell("none", "ViteHub does not provide Nitro provisioning."),
          node: cell("none", "ViteHub does not provide one self-hosted provisioning plan."),
        },
      },
    ],
  },
  {
    label: "Proof",
    rows: [
      {
        id: "contract-tests",
        label: "Contract tests",
        description: "Source and generated-output assertions",
        proof: "contract",
      },
      {
        id: "local-run",
        label: "Local provider run",
        description: "Built output exercised in CI",
        proof: "local-provider-run",
      },
      {
        id: "live-smoke",
        label: "Live smoke",
        description: "Shared playground deployed nightly",
        proof: "deployed-runtime",
      },
    ],
  },
];

/** Host names in the Markdown tables of the support page. */
const markdownHostLabels: Record<SupportHost, string> = {
  local: "Local Vite",
  cloudflare: "Cloudflare",
  vercel: "Vercel",
  netlify: "Netlify",
  deno: "Deno",
  nitro: "Nitro and UnJS",
  node: "Node and self-hosted",
};

const markdownTables = {
  "server-primitives": { group: serverPrimitives, heading: "Primitive" },
  "application-features": { group: applicationFeatures, heading: "Feature" },
};

/** The Markdown table of a catalog group. The support page keeps it between generated markers. */
export function renderSupportMatrixMarkdownTable(anchor: keyof typeof markdownTables): string {
  const { group, heading } = markdownTables[anchor];
  const lines = [
    `| ${heading} | ${supportHosts.map((host) => markdownHostLabels[host]).join(" | ")} |`,
    `| --- | ${supportHosts.map(() => "---").join(" | ")} |`,
  ];
  for (const row of group.rows) {
    if (!("values" in row)) continue;
    const cells = supportHosts.map((host) => row.values[host].display ?? "—");
    lines.push(`| ${row.label} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

export const supportLevels: SupportLevel[] = ["available", "package", "local", "none"];
export const supportProofStates: SupportProofState[] = [
  "current",
  "stale",
  "incomplete",
  "failed",
  "unpublished",
  "not-applicable",
];

export const supportMatrixStatuses: Record<
  SupportMatrixStatus,
  { description: string; label: string }
> = {
  available: {
    label: "Available",
    description: "A built-in provider or generated output works on this host.",
  },
  package: {
    label: "Package-specific",
    description:
      "Support belongs to the named package, an explicit provider choice, or generated output, not to the host as a whole.",
  },
  local: {
    label: "Local-only",
    description: "The provider keeps state in one process. Use it for development or a single-process server.",
  },
  none: {
    label: "Not provided",
    description: "ViteHub has no provider or output for this host.",
  },
  current: {
    label: "Current proof",
    description: "The latest owned run succeeded and is newer than its freshness limit.",
  },
  stale: {
    label: "Stale proof",
    description: "The latest successful run is older than its freshness limit.",
  },
  incomplete: {
    label: "Stage-incomplete proof",
    description: "The live run stopped before its runtime stage, for example at provision.",
  },
  failed: {
    label: "Failed proof",
    description: "The latest owned run failed.",
  },
  unpublished: {
    label: "Proof not published",
    description: "No owned run publishes evidence for this host yet.",
  },
  "not-applicable": {
    label: "Not applicable",
    description: "This proof tier does not apply to this host.",
  },
};
