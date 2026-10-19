<script setup lang="ts">
import {
  supportLevels,
  supportMatrixGroups,
  supportMatrixHosts,
  supportMatrixStatuses,
  supportProofStates,
  type SupportMatrixRow,
  type SupportMatrixStatus,
} from "../../data/support-matrix";
import {
  supportProofFor,
  supportProofLedger,
  supportProofPresentation,
} from "../../data/support-proof";

// The Markdown tables in the default slot are the text version of this matrix for Copy page and agents.
// The matrix renders the same data from the data files, so the slot stays hidden.

type MatrixCell = {
  detail: string;
  display?: string;
  evidence?: { observedAt: string; url: string };
  status: SupportMatrixStatus;
};

type MatrixRow = SupportMatrixRow & { cells: MatrixCell[]; group: string };

const hosts = supportMatrixHosts;
const coverageGroup = "Server primitives";
const NuxtLink = resolveComponent("NuxtLink");

const route = useRoute();
const filter = ref("");
const differing = ref(false);
const hoveredColumn = ref<number>();
const highlighted = computed(() => hosts.findIndex((host) => host.id === route.query.host));
// The server and the first client render share this time, so proof states hydrate without a mismatch.
const proofObservedAt = useState("support-proof-observed-at", () => new Date().toISOString());

const groups = computed(() => {
  const now = new Date(proofObservedAt.value);
  return supportMatrixGroups.map((group) => ({
    ...group,
    rows: group.rows.map(
      (row): MatrixRow => ({
        ...row,
        group: group.label,
        cells: hosts.map((host) => {
          if ("values" in row) return row.values[host.id];
          const proof = supportProofPresentation(supportProofFor(row.proof, host.id), now);
          return {
            detail: proof.detail,
            display: proof.display,
            evidence: proof.evidence,
            status: proof.state,
          };
        }),
      }),
    ),
  }));
});
const rows = computed(
  () => new Map(groups.value.flatMap((group) => group.rows.map((row) => [row.id, row]))),
);
const total = supportMatrixGroups.reduce((count, group) => count + group.rows.length, 0);

const visible = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  return groups.value
    .map((group) => ({
      ...group,
      rows: group.rows.filter(
        (row) =>
          (!needle ||
            [row.label, row.description, ...row.cells.map((cell) => cell.display ?? "")].some(
              (text) => text.toLowerCase().includes(needle),
            )) &&
          (!differing.value || new Set(row.cells.map((cell) => cell.status)).size > 1),
      ),
    }))
    .filter((group) => group.rows.length);
});
const status = computed(
  () =>
    `${visible.value.reduce((count, group) => count + group.rows.length, 0)} of ${total} rows shown`,
);

// Rotated labels need a header as tall as the longest label is wide at 45 degrees.
const headerHeight = `calc(${Math.max(...hosts.map((host) => host.label.length))}ch * 0.71 + 3.5rem)`;

const coverage = computed(() => {
  const group = groups.value.find((item) => item.label === coverageGroup)!;
  return hosts.map((_, index) => {
    const counts = { available: 0, package: 0, local: 0 };
    for (const row of group.rows) {
      const cellStatus = row.cells[index]!.status;
      if (cellStatus in counts) counts[cellStatus as keyof typeof counts]++;
    }
    return { counts, total: group.rows.length };
  });
});

const TIP_HALF_WIDTH = 144;
const wrapper = useTemplateRef("wrapper");
const tip = ref<{ column: number; row: MatrixRow; x: number; y: number }>();
const tipCell = computed(() => tip.value && tip.value.row.cells[tip.value.column]!);

function inspect(event: Event) {
  const target = (event.target as HTMLElement).closest<HTMLTableCellElement>("td, th");
  const column =
    target && target.cellIndex > 0 && target.colSpan === 1 ? target.cellIndex - 1 : undefined;
  hoveredColumn.value = column;
  const id = target?.parentElement?.dataset.row;
  const row = id ? rows.value.get(id) : undefined;
  if (!target || !row || column === undefined || !wrapper.value) {
    tip.value = undefined;
    return;
  }
  const box = target.getBoundingClientRect();
  const origin = wrapper.value.getBoundingClientRect();
  const x = Math.min(
    Math.max(box.left + box.width / 2 - origin.left, TIP_HALF_WIDTH),
    origin.width - TIP_HALF_WIDTH,
  );
  tip.value = { column, row, x, y: box.top - origin.top };
}

function leave() {
  hoveredColumn.value = undefined;
  tip.value = undefined;
}

function describe(cell: MatrixCell) {
  const label = supportMatrixStatuses[cell.status].label;
  return cell.display && cell.display !== "—" ? `${label}: ${cell.display}` : label;
}

// A proof state goes stale when its evidence passes the freshness limit, so refresh at the next expiry.
let proofRefreshTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleProofRefresh(): void {
  const now = Date.now();
  const nextExpiry = supportProofLedger
    .flatMap((claim) => {
      const observedAt = Date.parse(claim.evidence.observedAt ?? "");
      const maxAgeDays = claim.freshness.maxAgeDays;
      return Number.isFinite(observedAt) && maxAgeDays !== null
        ? [observedAt + maxAgeDays * 86_400_000]
        : [];
    })
    .filter((expiresAt) => expiresAt >= now)
    .sort((left, right) => left - right)[0];
  if (nextExpiry === undefined) return;

  proofRefreshTimer = setTimeout(
    () => {
      proofObservedAt.value = new Date().toISOString();
      scheduleProofRefresh();
    },
    Math.min(nextExpiry - now + 1, 2_147_000_000),
  );
}

onMounted(() => {
  proofObservedAt.value = new Date().toISOString();
  scheduleProofRefresh();
});
onBeforeUnmount(() => clearTimeout(proofRefreshTimer));
</script>

<template>
  <div class="not-prose my-8">
    <div class="mb-6 flex flex-wrap items-center gap-x-6 gap-y-3">
      <UInput
        v-model="filter"
        icon="i-lucide-search"
        placeholder="Filter primitives or providers"
        aria-label="Filter primitives or providers"
        class="w-full sm:w-72"
        :ui="{ base: 'font-mono text-xs' }"
      />
      <USwitch v-model="differing" label="Only rows that differ" size="sm" />
      <p class="sr-only" role="status">{{ status }}</p>
    </div>

    <div class="space-y-2 text-xs text-muted">
      <div
        v-for="legend of [
          { label: 'Support', statuses: supportLevels },
          { label: 'Proof', statuses: supportProofStates },
        ]"
        :key="legend.label"
        class="flex gap-3"
      >
        <span class="w-14 shrink-0 font-mono text-toned">{{ legend.label }}</span>
        <ul class="flex flex-wrap items-center gap-x-5 gap-y-2">
          <li
            v-for="level of legend.statuses"
            :key="level"
            class="inline-flex items-center gap-2"
          >
            <span class="support-cell support-swatch" :data-status="level" aria-hidden="true" />
            {{ supportMatrixStatuses[level].label }}
          </li>
        </ul>
      </div>

      <details class="group pt-1">
        <summary
          class="inline-flex cursor-pointer list-none items-center gap-1.5 hover:text-highlighted [&::-webkit-details-marker]:hidden"
        >
          <UIcon name="i-lucide-chevron-right" class="size-3.5 transition group-open:rotate-90" />
          What the statuses mean
        </summary>
        <dl
          class="mt-3 grid gap-x-4 gap-y-2.5 rounded-lg border border-default p-4 sm:grid-cols-[auto_1fr]"
        >
          <template v-for="(meta, level) of supportMatrixStatuses" :key="level">
            <dt class="flex items-center gap-2 font-medium text-highlighted">
              <span
                class="support-cell support-swatch [--support-cell-size:0.75rem]"
                :data-status="level"
                aria-hidden="true"
              />
              {{ meta.label }}
            </dt>
            <dd class="max-sm:mb-1.5">{{ meta.description }}</dd>
          </template>
          <dd class="sm:col-span-2">
            Hover over a cell to see the provider and its limits. Select a proof cell to open its
            evidence.
          </dd>
        </dl>
      </details>
    </div>

    <div
      ref="wrapper"
      class="relative mt-2"
      @pointerover="inspect"
      @focusin="inspect"
      @pointerleave="leave"
      @focusout="leave"
    >
      <table
        class="support-matrix interlaced-matrix w-full border-separate border-spacing-0 pr-12 lg:w-max lg:pr-16"
        :style="{ '--matrix-columns': hosts.length }"
      >
        <caption class="sr-only">
          Support for each contract, by host
        </caption>
        <colgroup>
          <col class="w-40 xl:w-48" />
          <col
            v-for="(host, index) of hosts"
            :key="host.id"
            class="w-14 transition-colors"
            :class="{ 'bg-elevated': index === hoveredColumn || index === highlighted }"
          />
        </colgroup>
        <thead class="sticky-matrix-head sticky top-(--ui-header-height) z-10">
          <tr>
            <th scope="col"><span class="sr-only">Contract</span></th>
            <th v-for="(host, index) of hosts" :key="host.id" scope="col" class="p-0 align-bottom">
              <component
                :is="host.to ? NuxtLink : 'span'"
                :to="host.to"
                class="relative flex flex-col items-center justify-end gap-2 pb-2 font-mono text-[11px] text-muted transition hover:text-highlighted lg:text-xs"
                :class="{
                  'text-highlighted': index === hoveredColumn || index === highlighted,
                }"
                :style="{ height: headerHeight }"
              >
                <span
                  class="absolute bottom-9 left-1/2 origin-bottom-left -rotate-45 whitespace-nowrap"
                >
                  {{ host.label }}
                </span>
                <UIcon :name="host.icon" class="size-4" aria-hidden="true" />
              </component>
            </th>
          </tr>
        </thead>

        <tbody v-for="group of visible" :key="group.label">
          <tr>
            <th :colspan="hosts.length + 1" scope="rowgroup" class="pt-6 pb-2 text-left">
              <span class="flex items-center gap-2 font-mono text-xs font-medium text-highlighted">
                <span class="size-1.5 bg-inverted" aria-hidden="true" />
                {{ group.label }}
                <span class="font-normal text-muted">{{ group.rows.length }}</span>
              </span>
            </th>
          </tr>
          <tr v-for="row of group.rows" :key="row.id" :data-row="row.id">
            <th
              scope="row"
              class="pr-4 text-left font-mono text-xs font-normal whitespace-nowrap text-default"
            >
              {{ row.label }}
              <span class="sr-only">. {{ row.description }}</span>
            </th>
            <td v-for="(cell, index) of row.cells" :key="hosts[index]!.id">
              <a
                v-if="cell.evidence"
                :href="cell.evidence.url"
                target="_blank"
                rel="noreferrer"
                class="support-cell-link"
                :aria-label="`${hosts[index]!.label}, ${row.label}: ${describe(cell)}. Evidence from ${cell.evidence.observedAt}`"
              >
                <span class="support-cell support-swatch" :data-status="cell.status" />
              </a>
              <template v-else>
                <span
                  class="support-cell support-swatch"
                  :data-status="cell.status"
                  aria-hidden="true"
                /><span class="sr-only">{{ describe(cell) }}</span>
              </template>
            </td>
          </tr>
        </tbody>

        <tbody v-if="!visible.length">
          <tr>
            <td :colspan="hosts.length + 1" class="py-10 text-center text-sm text-muted">
              No row matches “{{ filter }}”.
            </td>
          </tr>
        </tbody>

        <tfoot>
          <tr>
            <th
              scope="row"
              class="pt-6 text-left align-bottom text-xs font-normal max-lg:pb-3 lg:pb-6"
            >
              <span class="block font-mono text-highlighted">Coverage</span>
              <span class="block text-muted">
                Server primitives with a provider on the host
              </span>
            </th>
            <td
              v-for="(host, index) of hosts"
              :key="host.id"
              class="text-center align-bottom lg:pt-6"
            >
              <span class="mx-auto flex h-16 w-2.5 flex-col-reverse bg-elevated" aria-hidden="true">
                <span
                  v-for="level of ['available', 'package', 'local'] as const"
                  :key="level"
                  class="support-swatch block w-full"
                  :data-status="level"
                  :style="{
                    height: `${(coverage[index]!.counts[level] / coverage[index]!.total) * 100}%`,
                  }"
                />
              </span>
              <span
                class="mt-1.5 block font-mono text-[11px] text-muted tabular-nums"
                aria-hidden="true"
              >
                {{ coverage[index]!.counts.available + coverage[index]!.counts.package }}
              </span>
              <span class="sr-only">
                {{ coverage[index]!.counts.available }} available,
                {{ coverage[index]!.counts.package }} package-specific, and
                {{ coverage[index]!.counts.local }} local-only of {{ coverage[index]!.total }}
              </span>
            </td>
          </tr>
        </tfoot>
      </table>

      <div
        v-if="tip && tipCell"
        class="pointer-events-none absolute z-20 w-72 -translate-x-1/2 -translate-y-full rounded-md border border-default bg-default p-3 text-xs shadow-lg"
        :style="{ left: `${tip.x}px`, top: `${tip.y - 8}px` }"
        aria-hidden="true"
      >
        <div class="flex items-center gap-2 text-highlighted">
          <UIcon :name="hosts[tip.column]!.icon" class="size-3.5" />
          <span class="font-medium">{{ hosts[tip.column]!.label }}</span>
        </div>
        <div class="mt-1 font-mono text-muted">{{ tip.row.label }}</div>

        <div class="mt-3 flex items-center gap-2">
          <span
            class="support-cell support-swatch [--support-cell-size:0.75rem]"
            :data-status="tipCell.status"
          />
          <span class="text-default">{{ supportMatrixStatuses[tipCell.status].label }}</span>
          <span
            v-if="tipCell.display && tipCell.display !== '—'"
            class="ml-auto font-mono text-highlighted"
          >
            {{ tipCell.display }}
          </span>
        </div>

        <p class="mt-3 border-t border-default pt-2 leading-relaxed text-muted">
          {{ tipCell.detail }}
        </p>
        <div
          v-if="tipCell.evidence"
          class="mt-2 flex items-center gap-1 font-mono text-[11px] text-toned"
        >
          <UIcon name="i-lucide-external-link" class="size-3" />
          Evidence from {{ tipCell.evidence.observedAt }}
        </div>
      </div>
    </div>

    <div class="hidden"><slot /></div>
  </div>
</template>

<style>
/* Docs use one ink color for every state. Patterns, not hues, tell the statuses apart. */
:root {
  --support-ink: var(--ui-text-highlighted);
}

.support-cell {
  display: inline-block;
  flex: none;
  width: var(--support-cell-size, 1.125rem);
  height: var(--support-cell-size, 1.125rem);
  vertical-align: middle;
}

.support-swatch[data-status="available"],
.support-swatch[data-status="current"] {
  background: var(--support-ink);
}

.support-swatch[data-status="package"] {
  background: color-mix(in oklab, var(--support-ink) 35%, transparent);
  box-shadow: inset 0 0 0 1px var(--support-ink);
}

.support-swatch[data-status="local"] {
  background: repeating-linear-gradient(135deg, var(--support-ink) 0 1.5px, transparent 1.5px 3.5px);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--support-ink) 55%, transparent);
}

.support-swatch[data-status="stale"] {
  background: color-mix(in oklab, var(--support-ink) 12%, transparent);
  outline: 1px dashed var(--support-ink);
  outline-offset: -1px;
}

.support-swatch[data-status="incomplete"] {
  background: linear-gradient(to top, var(--support-ink) 50%, transparent 50%);
  box-shadow: inset 0 0 0 1px var(--support-ink);
}

.support-swatch[data-status="failed"] {
  background:
    linear-gradient(45deg, transparent calc(50% - 1px), var(--support-ink) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)),
    linear-gradient(-45deg, transparent calc(50% - 1px), var(--support-ink) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px));
  box-shadow: inset 0 0 0 1px var(--support-ink);
}

.support-swatch[data-status="none"],
.support-swatch[data-status="unpublished"] {
  background: color-mix(in oklab, var(--ui-bg-accented) 70%, transparent);
}

.support-swatch[data-status="not-applicable"] {
  background:
    linear-gradient(to top right, transparent calc(50% - 1px), var(--ui-text-muted) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)),
    color-mix(in oklab, var(--ui-bg-accented) 35%, transparent);
}

.support-cell-link {
  display: inline-flex;
  vertical-align: middle;
  border-radius: 2px;
}

.support-cell-link:hover .support-cell {
  outline: 2px solid var(--ui-text-highlighted);
  outline-offset: 2px;
}

.support-cell-link:focus-visible {
  outline: 2px solid var(--ui-text-highlighted);
  outline-offset: 2px;
}

.support-matrix tr[data-row] > * {
  border-top: 1px solid color-mix(in oklab, var(--ui-border) 60%, transparent);
  padding-block: 0.3rem;
}

.support-matrix tr[data-row] > th {
  font-weight: 400;
}

.support-matrix tr[data-row] > td {
  text-align: center;
}

.support-matrix tr[data-row]:hover > * {
  background: var(--ui-bg-elevated);
}

/* The sticky header blurs the rows that scroll under it. The blur sits behind each cell,
   so a rotated label that overflows its cell is not cut off by the next cell. */
.sticky-matrix-head th {
  position: relative;
}

.sticky-matrix-head th::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  background: color-mix(in oklab, var(--ui-bg) 75%, transparent);
  backdrop-filter: blur(8px);
}

/* On narrow screens each row header gets its own line, so every host column fits without scrolling. */
@media (width < 64rem) {
  .interlaced-matrix,
  .interlaced-matrix :is(thead, tbody, tfoot) {
    display: block;
  }

  .interlaced-matrix colgroup {
    display: none;
  }

  .interlaced-matrix tr {
    display: grid;
    grid-template-columns: repeat(var(--matrix-columns), minmax(0, 1fr));
  }

  .interlaced-matrix tr > :first-child {
    grid-column: 1 / -1;
  }

  .support-matrix tr[data-row] > th {
    padding-top: 0.5rem;
  }

  .support-matrix tr[data-row] > td {
    border-top: 0;
    padding-block: 0.125rem 0.5rem;
  }
}
</style>
