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
    icon: "i-ph-cloud-light",
    to: "/docs/frameworks-hosts/netlify",
  },
  {
    id: "deno",
    label: "Deno",
    icon: "i-ph-terminal-window-light",
    to: "/docs/frameworks-hosts/deno",
  },
  {
    id: "nitro",
    label: "Nitro / UnJS",
    icon: "i-unjs-nitro",
    to: "/docs/frameworks-hosts/nitro-unjs",
  },
  {
    id: "node",
    label: "Node / self-hosted",
    icon: "i-ph-hard-drives-light",
    to: "/docs/frameworks-hosts/node-self-hosted",
  },
];

const cell = (status: SupportLevel, detail: string, display?: string): SupportMatrixCell => ({
  detail,
  display,
  status,
});

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
  {
    label: "Server primitives",
    rows: [
      {
        id: "browser",
        label: "Browser",
        description: "Provider-backed browser operations",
        values: {
          local: cell(
            "package",
            "Pass createBrowser({ provider: localBrowser({ executablePath }) }) for a trusted local process. Browser Definitions do not select this provider.",
            "Local provider",
          ),
          cloudflare: cell(
            "available",
            "Cloudflare Browser Run binding and provider output.",
            "Browser Run",
          ),
          vercel: cell("none", "Browser Definitions do not have a Vercel provider.", "—"),
          netlify: cell("none", "Browser Definitions do not have a Netlify provider.", "—"),
          deno: cell("none", "Browser Definitions do not have a Deno provider.", "—"),
          nitro: cell(
            "none",
            "Browser Definitions require ViteHub's Cloudflare preset, not a generic Nitro preset.",
            "—",
          ),
          node: cell(
            "package",
            "Pass createBrowser({ provider: localBrowser({ executablePath }) }) for a trusted self-hosted Node process. Browser Definitions do not select this provider.",
            "Local provider",
          ),
        },
      },
      {
        id: "blob",
        label: "Blob",
        description: "Object storage",
        values: {
          local: cell("available", "Local filesystem storage for development.", "fs"),
          cloudflare: cell(
            "available",
            "Cloudflare R2 binding or S3-compatible HTTP access.",
            "R2",
          ),
          vercel: cell("available", "Vercel Blob through the vercel-blob driver.", "Vercel Blob"),
          netlify: cell(
            "available",
            "Netlify Blobs selected from the detected host.",
            "Netlify Blobs",
          ),
          deno: cell(
            "package",
            "Use a remote S3-compatible store. No Deno-native Blob driver is provided.",
            "S3",
          ),
          nitro: cell(
            "package",
            "Uses the Blob driver selected for the deployment host.",
            "Host driver",
          ),
          node: cell(
            "available",
            "Filesystem, S3-compatible, MinIO, or files-sdk drivers.",
            "fs / S3",
          ),
        },
      },
      {
        id: "database",
        label: "Database",
        description: "Named SQL databases",
        values: {
          local: cell("available", "Local SQLite through libSQL and Drizzle.", "SQLite"),
          cloudflare: cell(
            "available",
            "Cloudflare D1 binding, with authenticated HTTP available for development.",
            "D1",
          ),
          vercel: cell(
            "available",
            "Hosted libSQL or Cloudflare D1 over authenticated HTTP.",
            "libSQL / D1",
          ),
          netlify: cell(
            "package",
            "Use a hosted libSQL connection. No Netlify-native database driver is provided.",
            "libSQL",
          ),
          deno: cell(
            "package",
            "Use a hosted libSQL connection. No Deno-native database driver is provided.",
            "libSQL",
          ),
          nitro: cell(
            "available",
            "Nuxt can wire one Cloudflare D1 host resource for Nuxt Content and Nitro.",
            "Nuxt D1",
          ),
          node: cell(
            "available",
            "SQLite or hosted libSQL through the selected Database connection.",
            "SQLite / libSQL",
          ),
        },
      },
      {
        id: "email",
        label: "Email",
        description: "Transactional email delivery",
        values: {
          local: cell(
            "package",
            "Configure the built-in Resend driver for local delivery.",
            "Resend",
          ),
          cloudflare: cell(
            "available",
            "The Cloudflare preset supports the built-in Cloudflare Email driver default or Resend.",
            "Cloudflare Email",
          ),
          vercel: cell("package", "Configure the built-in Resend driver.", "Resend"),
          netlify: cell("package", "Configure the built-in Resend driver.", "Resend"),
          deno: cell(
            "package",
            "Configure the built-in fetch-based Resend driver.",
            "Resend",
          ),
          nitro: cell(
            "package",
            "Uses the explicit ViteHub Email driver selected for the deployment host.",
            "Host driver",
          ),
          node: cell("package", "Configure Resend or provide a custom ViteHub Email driver.", "Resend / custom"),
        },
      },
      {
        id: "kv",
        label: "KV",
        description: "Key-value storage",
        values: {
          local: cell("available", "Local filesystem-backed KV for development.", "fs-lite"),
          cloudflare: cell("available", "Cloudflare Workers KV binding.", "Workers KV"),
          vercel: cell("available", "Upstash Redis with KV REST credentials.", "Upstash"),
          netlify: cell(
            "package",
            "Configure a remote Upstash store. No Netlify-native KV output is provided.",
            "Upstash",
          ),
          deno: cell("available", "Native Deno KV through Deno.openKv().", "Deno KV"),
          nitro: cell(
            "package",
            "Uses the KV driver selected for the deployment host.",
            "Host driver",
          ),
          node: cell(
            "available",
            "Filesystem-backed KV or remote Upstash Redis.",
            "fs-lite / Upstash",
          ),
        },
      },
      {
        id: "queue",
        label: "Queue",
        description: "Message delivery",
        values: {
          local: cell(
            "none",
            "Local Vite discovers Queue Definitions and generates provider output, but it does not deliver Queue Jobs locally.",
            "Discovery only",
          ),
          cloudflare: cell("available", "Cloudflare Queues bindings and consumers.", "Queues"),
          vercel: cell("available", "Vercel Queues callbacks and runtime client.", "Vercel Queues"),
          netlify: cell(
            "package",
            "Select the Cloudflare or Vercel Queue Provider explicitly because Netlify cannot infer one.",
            "Cloudflare / Vercel",
          ),
          deno: cell("none", "No Deno Queue provider is provided.", "—"),
          nitro: cell(
            "package",
            "Cloudflare Queue bindings or the Vercel Queues runtime client can be composed through Nitro output.",
            "Cloudflare / Vercel",
          ),
          node: cell("none", "No standalone self-hosted Queue provider is provided.", "—"),
        },
      },
      {
        id: "rate-limit",
        label: "Rate Limit",
        description: "Atomic request budgets",
        values: {
          local: cell("local", "Process-local memory driver for development and tests.", "memory"),
          cloudflare: cell("available", "Native Cloudflare Rate Limiting binding.", "Cloudflare"),
          vercel: cell("none", "ViteHub has no native Vercel Rate Limit driver.", "—"),
          netlify: cell("none", "ViteHub has no native Netlify Rate Limit driver.", "—"),
          deno: cell("none", "ViteHub has no native Deno Rate Limit driver.", "—"),
          nitro: cell(
            "package",
            "Cloudflare Nitro presets infer the Cloudflare binding.",
            "Cloudflare",
          ),
          node: cell("local", "The memory driver is safe only for a single process.", "memory"),
        },
      },
      {
        id: "realtime",
        label: "Realtime",
        description: "Authoritative collaborative rooms",
        values: {
          local: cell("local", "Process-memory authority for local development.", "memory"),
          cloudflare: cell(
            "available",
            "Cloudflare Durable Objects provide the production room authority.",
            "Durable Objects",
          ),
          vercel: cell(
            "none",
            "Realtime has no distributed Vercel authority, and process memory is rejected for the Vercel preset.",
            "—",
          ),
          netlify: cell(
            "none",
            "Realtime has no distributed Netlify authority, and process memory is rejected for the Netlify preset.",
            "—",
          ),
          deno: cell(
            "none",
            "Realtime has no distributed Deno authority, and process memory is rejected for the Deno preset.",
            "—",
          ),
          nitro: cell(
            "package",
            "Cloudflare Nitro output uses Durable Objects; a single-process Node server can select memory explicitly.",
            "Host authority",
          ),
          node: cell(
            "local",
            "Explicit memory authority is supported only for a single-process server.",
            "memory",
          ),
        },
      },
      {
        id: "sandbox",
        label: "Sandbox",
        description: "Isolated command execution",
        values: {
          local: cell(
            "package",
            "Runs through the explicitly selected Sandbox provider.",
            "Sandbox provider",
          ),
          cloudflare: cell("available", "Cloudflare Sandbox execution provider.", "CF Sandbox"),
          vercel: cell("available", "Vercel Sandbox execution provider.", "Vercel Sandbox"),
          netlify: cell(
            "package",
            "Netlify can use an explicitly selected Vercel Sandbox provider with Vercel credentials.",
            "Vercel Sandbox",
          ),
          deno: cell("none", "No Deno Sandbox provider is provided.", "—"),
          nitro: cell(
            "package",
            "Uses Cloudflare Sandbox or Vercel Sandbox when selected by the Nitro host.",
            "Cloudflare / Vercel",
          ),
          node: cell(
            "package",
            "Orchestration can call an explicitly configured Sandbox provider.",
            "Sandbox provider",
          ),
        },
      },
      {
        id: "schedule",
        label: "Schedule",
        description: "Static and runtime schedules",
        values: {
          local: cell(
            "available",
            "Local development runner and the explicit process runtime.",
            "Local / process",
          ),
          cloudflare: cell(
            "available",
            "Cloudflare scheduled events and Nitro Provider Wake.",
            "Cron triggers",
          ),
          vercel: cell("available", "Vercel Cron Jobs provider output.", "Vercel Cron"),
          netlify: cell(
            "available",
            "One generated Netlify scheduled function per static Schedule.",
            "Scheduled fn",
          ),
          deno: cell(
            "package",
            "The standalone Schedule integration generates Deno.cron wake output. vitehub({ preset: \"deno\", schedule: true }) is not supported.",
            "Standalone Deno.cron",
          ),
          nitro: cell(
            "available",
            "Nitro Provider Wake, or the process runtime on a long-lived host.",
            "Provider Wake",
          ),
          node: cell(
            "available",
            "Process runtime for one long-lived process or replica.",
            "process",
          ),
        },
      },
      {
        id: "workflow",
        label: "Workflow",
        description: "Durable execution",
        values: {
          local: cell(
            "available",
            "OpenWorkflow worker or inline development execution.",
            "OpenWorkflow",
          ),
          cloudflare: cell("available", "Cloudflare Workflows provider.", "CF Workflows"),
          vercel: cell(
            "available",
            "Vercel Workflow provider and Workflow DevKit output.",
            "Vercel Workflow",
          ),
          netlify: cell(
            "package",
            "Use OpenWorkflow explicitly. No Netlify-native Workflow provider is provided.",
            "OpenWorkflow",
          ),
          deno: cell(
            "package",
            "Use OpenWorkflow explicitly. No Deno-native Workflow provider is provided.",
            "OpenWorkflow",
          ),
          nitro: cell(
            "package",
            "Uses the Workflow provider selected for the deployment host.",
            "Host provider",
          ),
          node: cell("available", "OpenWorkflow worker or inline execution.", "OpenWorkflow"),
        },
      },
      {
        id: "workspace",
        label: "Workspace",
        description: "Agent file-tree state",
        values: {
          local: cell(
            "available",
            "Local filesystem or in-memory Workspace Store.",
            "local / memory",
          ),
          cloudflare: cell(
            "available",
            "Memory by default, or Cloudflare Artifacts beta and GitHub for durable state.",
            "Artifacts / GitHub",
          ),
          vercel: cell(
            "available",
            "Vercel Blob or GitHub Workspace Store for durable state.",
            "Blob / GitHub",
          ),
          netlify: cell(
            "package",
            "Select the GitHub Workspace Store explicitly for durable state.",
            "GitHub",
          ),
          deno: cell(
            "package",
            "Select the GitHub Workspace Store explicitly for durable state.",
            "GitHub",
          ),
          nitro: cell(
            "package",
            "Runtime setup uses the Workspace Store selected for the host.",
            "Host store",
          ),
          node: cell(
            "available",
            "Local filesystem, memory, or GitHub Workspace Store.",
            "local / GitHub",
          ),
        },
      },
    ],
  },
  {
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
