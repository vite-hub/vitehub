<script setup lang="ts">
type MatrixStatus = "available" | "package" | "local" | "none";

type MatrixCell = {
  detail: string;
  display?: string;
  status: MatrixStatus;
};

type MatrixColumn = {
  group: "Development" | "Hosted providers" | "Runtimes";
  icon: string;
  id: string;
  label: string;
  to?: string;
};

type MatrixRow = {
  description: string;
  id: string;
  label: string;
  values: Record<string, MatrixCell>;
};

const route = useRoute();
const navigationOpen = ref(false);
const openDetails = reactive<Record<string, boolean>>({});

watch(
  () => route.path,
  () => {
    navigationOpen.value = false;
  },
);

const columns: MatrixColumn[] = [
  { id: "local", label: "Local Vite", group: "Development", icon: "i-simple-icons-vite" },
  {
    id: "cloudflare",
    label: "Cloudflare",
    group: "Hosted providers",
    icon: "i-simple-icons-cloudflare",
    to: "/docs/frameworks-hosts/cloudflare",
  },
  {
    id: "vercel",
    label: "Vercel",
    group: "Hosted providers",
    icon: "i-simple-icons-vercel",
    to: "/docs/frameworks-hosts/vercel",
  },
  {
    id: "netlify",
    label: "Netlify",
    group: "Hosted providers",
    icon: "i-ph-cloud-light",
    to: "/docs/frameworks-hosts/netlify",
  },
  {
    id: "deno",
    label: "Deno",
    group: "Runtimes",
    icon: "i-ph-terminal-window-light",
    to: "/docs/frameworks-hosts/deno",
  },
  {
    id: "nitro",
    label: "Nitro / UnJS",
    group: "Runtimes",
    icon: "i-unjs-nitro",
    to: "/docs/frameworks-hosts/nitro-unjs",
  },
  {
    id: "node",
    label: "Node / self-hosted",
    group: "Runtimes",
    icon: "i-ph-hard-drives-light",
    to: "/docs/frameworks-hosts/node-self-hosted",
  },
];

const groups = [
  { label: "Development", columns: columns.filter((column) => column.group === "Development") },
  {
    label: "Hosted providers",
    columns: columns.filter((column) => column.group === "Hosted providers"),
  },
  { label: "Runtimes", columns: columns.filter((column) => column.group === "Runtimes") },
];

const cell = (status: MatrixStatus, detail: string, display?: string): MatrixCell => ({
  detail,
  display,
  status,
});

const sections: { label: string; rows: MatrixRow[] }[] = [
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
            "available",
            "Local development runs discovered Queue handlers in the playground.",
            "Local",
          ),
          cloudflare: cell("available", "Cloudflare Queues bindings and consumers.", "Queues"),
          vercel: cell("available", "Vercel Queues callbacks and runtime client.", "Vercel Queues"),
          netlify: cell("none", "No Netlify Queue provider is provided.", "—"),
          deno: cell("none", "No Deno Queue provider is provided.", "—"),
          nitro: cell(
            "package",
            "Cloudflare Queue bindings can be composed through Nitro output.",
            "Cloudflare",
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
        id: "sandbox",
        label: "Sandbox",
        description: "Isolated command execution",
        values: {
          local: cell(
            "package",
            "Runs through the explicitly selected Box provider.",
            "Box provider",
          ),
          cloudflare: cell("available", "Cloudflare Sandbox execution provider.", "CF Sandbox"),
          vercel: cell("available", "Vercel Sandbox execution provider.", "Vercel Sandbox"),
          netlify: cell("none", "No Netlify Sandbox provider is provided.", "—"),
          deno: cell("none", "No Deno Sandbox provider is provided.", "—"),
          nitro: cell(
            "package",
            "Uses Cloudflare Sandbox when the Nitro host exposes its bindings.",
            "Cloudflare",
          ),
          node: cell(
            "package",
            "Orchestration can call an explicitly configured Box provider.",
            "Box provider",
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
            "available",
            "Generated Deno.cron wake output for static Schedules.",
            "Deno.cron",
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
        values: {
          local: cell(
            "none",
            "Local Vite is not a generated deployment target. A local build can still generate output for an explicit or inferred hosted provider.",
          ),
          cloudflare: cell(
            "package",
            "Enabled integrations compose a Worker, wrangler.json, bindings, callbacks, and runtime modules.",
          ),
          vercel: cell(
            "package",
            "Enabled integrations write Vercel Build Output, functions, routes, cron entries, and runtime modules.",
          ),
          netlify: cell(
            "package",
            "Agent and Schedule write functions under .netlify/v1/functions.",
          ),
          deno: cell(
            "package",
            "Agent and Schedule write Deno entrypoints. ViteHub does not generate one general Deno bundle.",
          ),
          nitro: cell(
            "package",
            "Package integrations generate Nitro handlers, plugins, or configuration only where documented.",
          ),
          node: cell("none", "ViteHub does not emit one unified Node deployment bundle."),
        },
      },
      {
        id: "provisioning",
        label: "Provisioning",
        description: "Resources ViteHub can create",
        values: {
          local: cell("none", "Local providers do not need hosted resource provisioning."),
          cloudflare: cell(
            "package",
            "ViteHub can provision R2 buckets, D1 databases, and Cloudflare Queues.",
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
        values: {
          local: cell(
            "available",
            "Package and documentation CI assert local Runtime Helper contracts.",
          ),
          cloudflare: cell(
            "available",
            "Owning packages assert Cloudflare runtime and generated-output contracts.",
          ),
          vercel: cell(
            "available",
            "Owning packages assert Vercel runtime and generated-output contracts.",
          ),
          netlify: cell(
            "available",
            "Agent, Schedule, and the Netlify fixture have contract coverage.",
          ),
          deno: cell("available", "Agent and Schedule package tests assert Deno output."),
          nitro: cell("available", "Owning packages test their Nitro integration boundaries."),
          node: cell(
            "available",
            "Owning packages test their Node-compatible drivers and handlers.",
          ),
        },
      },
      {
        id: "local-run",
        label: "Local provider run",
        description: "Built output exercised in CI",
        values: {
          local: cell("none", "The Local Vite row makes no hosted-provider proof claim."),
          cloudflare: cell(
            "available",
            "Pull requests run the shared primitive playground against local Cloudflare output.",
          ),
          vercel: cell(
            "available",
            "Pull requests run the shared primitive playground against local Vercel adapters.",
          ),
          netlify: cell("available", "CI runs a real-project fixture through Netlify CLI."),
          deno: cell("none", "ViteHub does not publish one shared local Deno provider run."),
          nitro: cell("none", "ViteHub does not publish one unified local Nitro matrix run."),
          node: cell("none", "ViteHub does not publish one self-hosted deployment suite."),
        },
      },
      {
        id: "live-smoke",
        label: "Live smoke",
        description: "Shared playground deployed nightly",
        values: {
          local: cell("none", "Local Vite is not a hosted deployment target."),
          cloudflare: cell(
            "available",
            "The nightly Live Smoke deploys nine primitives, including Rate Limit. Browser and Agent routes are outside this run.",
          ),
          vercel: cell(
            "available",
            "The nightly Live Smoke deploys eight primitives. ViteHub has no native Vercel Rate Limit driver, and Agent routes are outside this run.",
          ),
          netlify: cell("none", "Live proof is not published for Netlify."),
          deno: cell("none", "Live proof is not published for Deno."),
          nitro: cell("none", "Live proof is not published as one unified Nitro matrix."),
          node: cell("none", "Live proof is not published as one self-hosted deployment suite."),
        },
      },
    ],
  },
];

const statusMeta: Record<MatrixStatus, { label: string; mark: string }> = {
  available: { label: "Available", mark: "✓" },
  package: { label: "Package-specific", mark: "●" },
  local: { label: "Local-only", mark: "◐" },
  none: { label: "Not provided", mark: "—" },
};
</script>

<template>
  <div class="support-matrix-page">
    <div class="support-matrix-navigation">
      <UPopover
        v-model:open="navigationOpen"
        :content="{ align: 'start', side: 'bottom', sideOffset: 8, collisionPadding: 8 }"
        :ui="{ content: 'support-matrix-navigation-panel' }"
      >
        <UButton
          icon="i-lucide-menu"
          color="neutral"
          variant="ghost"
          aria-label="Open documentation navigation"
          :aria-expanded="navigationOpen"
          class="support-matrix-navigation-button"
        />

        <template #content="{ close }">
          <aside aria-label="Documentation navigation" class="support-matrix-sidebar">
            <div class="support-matrix-sidebar-title">
              <span>Documentation</span>
              <UButton
                icon="i-lucide-x"
                color="neutral"
                variant="ghost"
                aria-label="Close documentation navigation"
                class="support-matrix-sidebar-close"
                @click="close"
              />
            </div>
            <DocsAsideLeftTop />
            <div class="support-matrix-sidebar-body">
              <DocsAsideLeftBody />
            </div>
          </aside>
        </template>
      </UPopover>
    </div>

    <header class="support-matrix-hero">
      <h1>Runtime and host support</h1>
      <p>Compare ViteHub runtime, output, provisioning, and proof across supported hosts.</p>
      <nav aria-label="Support matrix links">
        <NuxtLink to="/docs/reference/provider-output">Provider output →</NuxtLink>
        <NuxtLink to="/docs/development/verification">Verification →</NuxtLink>
        <NuxtLink to="https://github.com/vite-hub/vitehub" external>GitHub →</NuxtLink>
      </nav>
    </header>

    <section class="support-matrix-main" aria-label="Runtime and host support matrix">
      <div class="support-matrix-legend" aria-label="Status legend">
        <span v-for="(meta, status) in statusMeta" :key="status">
          <span class="support-matrix-mark" :data-status="status" aria-hidden="true">{{
            meta.mark
          }}</span>
          {{ meta.label }}
        </span>
      </div>

      <div class="support-matrix-scroll">
        <table class="support-matrix-table">
          <colgroup>
            <col class="support-matrix-feature-column" />
            <col v-for="column in columns" :key="column.id" class="support-matrix-host-column" />
          </colgroup>
          <thead>
            <tr>
              <th rowspan="2" scope="col" class="support-matrix-feature-heading">Contract</th>
              <th
                v-for="group in groups"
                :key="group.label"
                :colspan="group.columns.length"
                scope="colgroup"
                class="support-matrix-group-heading"
              >
                {{ group.label }}
              </th>
            </tr>
            <tr>
              <th
                v-for="column in columns"
                :key="column.id"
                scope="col"
                class="support-matrix-host-heading"
              >
                <NuxtLink v-if="column.to" :to="column.to" class="support-matrix-host-link">
                  <UIcon :name="column.icon" aria-hidden="true" />
                  <span>{{ column.label }}</span>
                </NuxtLink>
                <span v-else class="support-matrix-host-link">
                  <UIcon :name="column.icon" aria-hidden="true" />
                  <span>{{ column.label }}</span>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            <template v-for="(section, sectionIndex) in sections" :key="section.label">
              <tr class="support-matrix-section-row" :class="{ 'is-separated': sectionIndex > 0 }">
                <th scope="rowgroup">{{ section.label }}</th>
                <td v-for="column in columns" :key="column.id" />
              </tr>
              <tr v-for="row in section.rows" :key="row.id" class="support-matrix-data-row">
                <th scope="row">
                  <span>{{ row.label }}</span>
                  <small>{{ row.description }}</small>
                </th>
                <td v-for="column in columns" :key="column.id">
                  <UTooltip
                    v-model:open="openDetails[`${row.id}-${column.id}`]"
                    :text="row.values[column.id]!.detail"
                    :content="{ side: 'top', sideOffset: 8, collisionPadding: 12 }"
                    :ui="{ content: 'support-matrix-tooltip' }"
                  >
                    <button
                      type="button"
                      class="support-matrix-status"
                      :data-status="row.values[column.id]!.status"
                      :aria-label="`${column.label}, ${row.label}: ${statusMeta[row.values[column.id]!.status].label}. ${row.values[column.id]!.detail}`"
                      @click="
                        openDetails[`${row.id}-${column.id}`] =
                          !openDetails[`${row.id}-${column.id}`]
                      "
                    >
                      <span aria-hidden="true">{{
                        row.values[column.id]!.display ??
                        statusMeta[row.values[column.id]!.status].mark
                      }}</span>
                    </button>
                  </UTooltip>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>

    <footer class="support-matrix-footer">
      <span>Repository-backed support data</span>
      <NuxtLink to="/docs/frameworks-hosts">Hosts and runtimes</NuxtLink>
    </footer>
  </div>
</template>

<style>
.support-matrix-page {
  min-height: calc(100dvh - var(--ui-header-height));
  background: var(--ui-bg);
  color: var(--ui-text);
}

.support-matrix-navigation {
  position: fixed;
  z-index: 40;
  top: calc(var(--ui-header-height) + 0.5rem);
  left: 0.5rem;
}

.support-matrix-navigation-button,
.support-matrix-sidebar-close {
  width: 2.25rem;
  height: 2.25rem;
  border: 0 !important;
  border-radius: 0.375rem;
  background: color-mix(in srgb, var(--ui-bg) 88%, transparent);
  box-shadow: none !important;
  backdrop-filter: blur(8px);
}

.support-matrix-navigation-panel {
  width: min(20rem, calc(100dvw - 1rem));
  max-height: calc(100dvh - var(--ui-header-height) - 1rem);
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: 0.5rem;
  background: var(--ui-bg);
  box-shadow: 0 18px 50px color-mix(in srgb, var(--ui-text-highlighted) 14%, transparent);
}

.support-matrix-sidebar {
  display: flex;
  max-height: calc(100dvh - var(--ui-header-height) - 1rem);
  flex-direction: column;
}

.support-matrix-sidebar-title {
  display: flex;
  min-height: 2.75rem;
  align-items: center;
  justify-content: space-between;
  padding-left: 1.25rem;
  border-bottom: 1px solid var(--ui-border);
  color: var(--ui-text-highlighted);
  font-size: 0.8125rem;
  font-weight: 650;
}

.support-matrix-sidebar-body {
  min-height: 0;
  overflow-y: auto;
}

.support-matrix-hero {
  padding: 4.5rem 4rem 3rem;
  text-align: center;
}

.support-matrix-hero h1 {
  margin: 0;
  color: var(--ui-text-highlighted);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: clamp(2rem, 5vw, 3rem);
  font-weight: 500;
  line-height: 1.12;
  letter-spacing: -0.04em;
}

.support-matrix-hero p {
  max-width: 36rem;
  margin: 0.875rem auto 0;
  color: var(--ui-text-muted);
  font-size: 1rem;
  line-height: 1.65;
}

.support-matrix-hero nav {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 1rem;
  margin-top: 1rem;
}

.support-matrix-hero a,
.support-matrix-footer a {
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
  text-decoration: none;
  transition: color 150ms ease;
}

.support-matrix-hero a:hover,
.support-matrix-footer a:hover {
  color: var(--ui-text-highlighted);
}

.support-matrix-main {
  width: 100%;
  padding: 0 1rem 4rem;
}

.support-matrix-legend {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem 1rem;
  padding: 0 0.5rem 0.75rem;
  color: var(--ui-text-muted);
  font-size: 0.75rem;
}

.support-matrix-legend > span {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.support-matrix-mark {
  display: inline-grid;
  width: 1rem;
  place-items: center;
  color: var(--ui-text-muted);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-weight: 650;
}

.support-matrix-mark[data-status="available"] {
  color: var(--ui-text-highlighted);
}

.support-matrix-scroll {
  width: 100%;
  max-height: calc(100dvh - var(--ui-header-height) - 1rem);
  overflow: auto;
  overscroll-behavior-inline: contain;
}

.support-matrix-table {
  width: 100%;
  min-width: 68rem;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 0.875rem;
}

.support-matrix-feature-column {
  width: 13rem;
}

.support-matrix-host-column {
  width: 8rem;
}

.support-matrix-table thead {
  position: sticky;
  z-index: 10;
  top: 0;
}

.support-matrix-table thead th {
  background: color-mix(in srgb, var(--ui-bg-muted) 72%, var(--ui-bg));
}

.support-matrix-feature-heading,
.support-matrix-group-heading,
.support-matrix-host-heading {
  border-bottom: 1px solid var(--ui-border);
}

.support-matrix-feature-heading {
  padding: 0.75rem;
  color: var(--ui-text-highlighted);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-weight: 500;
  text-align: left;
}

.support-matrix-group-heading {
  padding: 0.6rem 0.5rem;
  border-left: 1px solid color-mix(in srgb, var(--ui-border) 65%, transparent);
  color: var(--ui-text-muted);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.6875rem;
  font-weight: 500;
  letter-spacing: 0.05em;
  text-align: center;
  text-transform: uppercase;
}

.support-matrix-host-heading {
  padding: 0;
  vertical-align: middle;
}

.support-matrix-host-heading:first-of-type,
.support-matrix-host-heading:nth-of-type(2),
.support-matrix-host-heading:nth-of-type(5) {
  border-left: 1px solid color-mix(in srgb, var(--ui-border) 65%, transparent);
}

.support-matrix-host-link {
  display: flex;
  min-height: 4.25rem;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0.5rem;
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1.2;
  text-align: center;
  text-decoration: none;
}

a.support-matrix-host-link:hover {
  color: var(--ui-text-highlighted);
}

.support-matrix-host-link svg {
  width: 1.125rem;
  height: 1.125rem;
}

.support-matrix-section-row.is-separated {
  border-top: 1px solid var(--ui-border);
}

.support-matrix-section-row th,
.support-matrix-section-row td {
  height: 3rem;
  padding: 1rem 0.75rem 0.5rem;
}

.support-matrix-section-row th {
  color: var(--ui-text-muted);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.6875rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-align: left;
  text-transform: uppercase;
}

.support-matrix-section-row td:first-of-type,
.support-matrix-data-row td:first-of-type,
.support-matrix-section-row td:nth-of-type(2),
.support-matrix-data-row td:nth-of-type(2),
.support-matrix-section-row td:nth-of-type(5),
.support-matrix-data-row td:nth-of-type(5) {
  border-left: 1px solid color-mix(in srgb, var(--ui-border) 65%, transparent);
}

.support-matrix-data-row {
  border-top: 1px solid color-mix(in srgb, var(--ui-border) 64%, transparent);
  transition: background-color 120ms ease;
}

.support-matrix-data-row:hover {
  background: color-mix(in srgb, var(--ui-bg-muted) 48%, transparent);
}

.support-matrix-data-row > th {
  padding: 0.8rem 0.75rem;
  color: var(--ui-text-highlighted);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-weight: 500;
  text-align: left;
}

.support-matrix-data-row > th small {
  display: block;
  margin-top: 0.2rem;
  color: var(--ui-text-muted);
  font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
  font-size: 0.6875rem;
  font-weight: 400;
  line-height: 1.35;
}

.support-matrix-data-row td {
  height: 4.25rem;
  padding: 0.5rem;
  text-align: center;
}

.support-matrix-status {
  display: inline-grid;
  width: 100%;
  min-height: 2rem;
  place-items: center;
  padding: 0.25rem;
  border: 0;
  border-radius: 0.25rem;
  background: transparent;
  color: var(--ui-text-muted);
  cursor: help;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.6875rem;
  font-weight: 650;
  line-height: 1.25;
  transition:
    background-color 120ms ease,
    color 120ms ease;
}

.support-matrix-status[data-status="available"] {
  color: var(--ui-text-highlighted);
}

.support-matrix-status[data-status="none"] {
  color: color-mix(in srgb, var(--ui-text-muted) 50%, transparent);
}

.support-matrix-status:hover,
.support-matrix-status:focus-visible {
  background: var(--ui-bg-muted);
  color: var(--ui-text-highlighted);
}

.support-matrix-status:focus-visible {
  outline: 2px solid var(--ui-text-highlighted);
  outline-offset: 2px;
}

.support-matrix-tooltip {
  max-width: min(23rem, calc(100vw - 1rem));
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--ui-border);
  border-radius: 0.375rem;
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
  font-size: 0.75rem;
  line-height: 1.45;
  text-align: left;
  box-shadow: 0 12px 32px color-mix(in srgb, var(--ui-text-highlighted) 12%, transparent);
}

.support-matrix-footer {
  display: flex;
  justify-content: center;
  gap: 1rem;
  padding: 2rem 1rem;
  border-top: 1px solid color-mix(in srgb, var(--ui-border) 70%, transparent);
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
}

@media (max-width: 640px) {
  .support-matrix-hero {
    padding: 4rem 1rem 2.5rem;
  }

  .support-matrix-hero h1 {
    font-size: 2rem;
  }

  .support-matrix-main {
    padding-inline: 0.75rem;
  }

  .support-matrix-legend {
    justify-content: flex-start;
  }

  .support-matrix-footer {
    align-items: center;
    flex-direction: column;
    gap: 0.4rem;
  }
}
</style>
