<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute } from "vue-router";

import {
  consoleDocumentStateColor,
  consoleDocumentStateLabel,
  consoleErrorMessage,
  consolePublishMismatches,
  consoleSingularLabel,
} from "../client/documents";
import { publishConsoleDocumentChanges } from "../client/publish";
import { useConsoleToast } from "../client/toast";
import { resolveConsoleRouteName } from "../console-route";
import { consoleSectionRouteName } from "../sections";
import ConsoleRelativeTime from "./console-relative-time.vue";
import ConsoleStatus from "./console-status.vue";

import type { ConsoleDocumentActivity, ConsoleDocumentOverview, ConsoleDocumentPendingChange, ConsoleDocumentsClient, ConsoleDocumentState } from "../client/documents";
import type { ConsoleDocumentCollection } from "../definitions";

/**
 * The dashboard of a document editor section: counts by state, the changes that wait for a publish, recent activity,
 * and a New button per collection. The section shell loads the overview once and shares it with the sidebar counts.
 */
const props = defineProps<{
  client: ConsoleDocumentsClient;
  collections: readonly ConsoleDocumentCollection[];
  error?: unknown;
  label: string;
  loading: boolean;
  overview?: ConsoleDocumentOverview;
  section: string;
}>();

const emit = defineEmits<{ changed: [], reload: [] }>();

const route = useRoute();
const toast = useConsoleToast();
const publishing = ref(false);
const publishOpen = ref(false);
// Changes published in this view leave the list at once; the next overview confirms it.
const published = ref(new Set<string>());

const byName = computed(() => new Map(props.collections.map(collection => [collection.name, collection])));
const totals = computed(() => {
  const totals: Record<ConsoleDocumentState, number> = { draft: 0, changed: 0, published: 0, deleted: 0 };
  for (const entry of props.overview?.collections ?? []) {
    for (const state of Object.keys(totals) as ConsoleDocumentState[]) totals[state] += entry.states[state];
  }
  return totals;
});
const stats = computed(() => (["draft", "changed", "published", "deleted"] as const).map(state => ({
  count: totals.value[state],
  label: { changed: "Changed", deleted: "Deleted", draft: "Drafts", published: "Published" }[state],
  state,
})));
const pending = computed(() => (props.overview?.collections ?? [])
  .flatMap(entry => entry.changes.map(change => ({ change, collection: byName.value.get(entry.name) })))
  .filter((entry): entry is { change: ConsoleDocumentPendingChange, collection: ConsoleDocumentCollection } => Boolean(entry.collection) && !published.value.has(key(entry.collection!.name, entry.change.id)))
  .sort((left, right) => (right.change.updatedAt ?? "").localeCompare(left.change.updatedAt ?? "")));
// Writers see the changes, but only collections they may publish count toward the Publish button.
const publishable = computed(() => pending.value.filter(entry => entry.collection.access.publish));
const canPublishAny = computed(() => props.collections.some(collection => collection.access.publish));
const writable = computed(() => props.collections.filter(collection => collection.access.write));
const firstLoad = computed(() => props.loading && !props.overview);

function key(collection: string, id: string): string {
  return `${collection}\u0000${id}`;
}

function mainRouteName(): string {
  return resolveConsoleRouteName(route.name, consoleSectionRouteName(props.section));
}

function documentRoute(collection: string, id: string) {
  return { name: mainRouteName(), params: { collection, document: id.split("/") }, query: {} };
}

function collectionRoute(collection: string) {
  return { name: mainRouteName(), params: { collection, document: [] }, query: {} };
}

function newRoute(collection: string) {
  return { name: mainRouteName(), params: { collection, document: [] }, query: { new: "1" } };
}

const verbs: Record<string, string> = { publish: "published", remove: "deleted", restore: "restored", save: "edited" };

function activityVerb(entry: ConsoleDocumentActivity): string {
  return verbs[entry.action] ?? "changed";
}

function collectionLabel(name: string): string {
  return byName.value.get(name)?.label ?? name;
}

async function publishAll(): Promise<void> {
  const targets = publishable.value;
  if (publishing.value || !targets.length) return;
  publishOpen.value = false;
  publishing.value = true;
  const before = published.value;
  published.value = new Set([...before, ...targets.map(entry => key(entry.collection.name, entry.change.id))]);
  try {
    const count = await publishConsoleDocumentChanges(props.client, targets.map(entry => ({ collection: entry.collection.name, change: entry.change })));
    if (count) toast.show({ title: count === 1 ? "Change published" : `${count} changes published` });
    emit("changed");
  }
  catch (publishError) {
    published.value = before;
    const moved = consolePublishMismatches(publishError);
    if (moved) toast.error(moved.length === 1 ? "A draft changed after this page loaded. Refresh and publish again." : `${moved.length} drafts changed after this page loaded. Refresh and publish again.`, { label: "Refresh", onClick: () => emit("reload") });
    else toast.error(`Couldn't publish. ${consoleErrorMessage(publishError, "Try again.")}`, { label: "Retry", onClick: publishAll });
    emit("changed");
  }
  finally {
    publishing.value = false;
  }
}
</script>

<template>
  <UDashboardNavbar :ui="{ root: 'border-b border-default', right: 'gap-2' }" :toggle="{ 'aria-label': 'Open section navigation' }">
    <template #title>
      <span class="truncate text-sm font-semibold text-highlighted">{{ label }}</span>
    </template>
    <template #right>
      <UPopover v-if="canPublishAny && publishable.length" v-model:open="publishOpen">
        <UButton size="sm" label="Publish" :loading="publishing" :aria-label="`Publish ${publishable.length} ${publishable.length === 1 ? 'change' : 'changes'}`">
          <template #trailing>
            <span class="tabular-nums opacity-70">{{ publishable.length }}</span>
          </template>
        </UButton>
        <template #content>
          <div class="grid max-w-72 gap-3 p-3">
            <p class="text-[13px] text-muted">
              Publish the {{ publishable.length === 1 ? "change" : `${publishable.length} changes` }} listed under Needs publishing, exactly as they are now.
            </p>
            <div class="flex justify-end gap-2">
              <UButton variant="ghost" size="sm" label="Cancel" @click="publishOpen = false" />
              <UButton size="sm" label="Publish all" :loading="publishing" @click="publishAll" />
            </div>
          </div>
        </template>
      </UPopover>
    </template>
  </UDashboardNavbar>

  <div class="min-h-0 flex-1 overflow-y-auto" :aria-busy="loading">
    <div class="mx-auto grid max-w-5xl gap-8 px-4 py-6 sm:px-6">
      <UAlert
        v-if="error && !overview"
        color="error"
        variant="subtle"
        icon="i-lucide-cloud-off"
        title="Couldn't load the dashboard"
        :description="consoleErrorMessage(error)"
        :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', color: 'neutral', variant: 'outline', onClick: () => emit('reload') }]"
      />

      <!-- Counts: one hairline strip, the numbers lead and the labels follow quietly. -->
      <section aria-label="Documents by state" class="grid grid-cols-2 overflow-hidden rounded-lg border border-default sm:grid-cols-4">
        <div
          v-for="(stat, index) in stats"
          :key="stat.state"
          class="grid gap-1 px-4 py-3"
          :class="[index % 2 ? 'border-s border-default' : '', index > 1 ? 'border-t border-default sm:border-t-0' : '', index === 2 ? 'sm:border-s' : '']"
        >
          <ConsoleStatus :tone="consoleDocumentStateColor(stat.state)" :label="stat.label" />
          <USkeleton v-if="firstLoad" class="h-7 w-10 rounded" />
          <span v-else class="text-2xl font-semibold tracking-tight text-highlighted tabular-nums">{{ stat.count }}</span>
        </div>
      </section>

      <div class="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div class="grid gap-8">
          <section aria-labelledby="needs-publishing" class="grid gap-2">
            <header class="flex items-baseline justify-between gap-3">
              <h2 id="needs-publishing" class="text-[13px] font-medium text-highlighted">
                Needs publishing
                <span v-if="pending.length" class="ms-1 font-normal text-dimmed tabular-nums">{{ pending.length }}</span>
              </h2>
              <p v-if="pending.length && !canPublishAny" class="text-xs text-dimmed">An editor publishes these.</p>
            </header>
            <div v-if="firstLoad" class="grid gap-px">
              <USkeleton v-for="index in 3" :key="index" class="h-11 rounded-md" />
            </div>
            <div v-else-if="!pending.length" class="rounded-lg border border-dashed border-default px-4 py-6 text-center">
              <p class="text-[13px] text-highlighted">Everything is published</p>
              <p class="mt-1 text-xs text-muted">Drafts and edits show here until someone publishes them.</p>
            </div>
            <ul v-else class="divide-y divide-default overflow-hidden rounded-lg border border-default">
              <li v-for="entry in pending.slice(0, 12)" :key="`${entry.collection.name}/${entry.change.id}`">
                <RouterLink
                  :to="entry.change.state === 'deleted' ? collectionRoute(entry.collection.name) : documentRoute(entry.collection.name, entry.change.id)"
                  class="flex h-11 min-w-0 items-center gap-3 px-3 hover:bg-elevated/60 focus-visible:outline-2 focus-visible:-outline-offset-2"
                >
                  <ConsoleStatus class="w-20 shrink-0" :tone="consoleDocumentStateColor(entry.change.state)" :label="consoleDocumentStateLabel(entry.change.state)" />
                  <span class="min-w-0 flex-1 truncate text-sm text-highlighted" :class="{ 'text-muted line-through decoration-(--ui-text-dimmed)': entry.change.state === 'deleted' }">{{ entry.change.title }}</span>
                  <span class="hidden shrink-0 text-xs text-dimmed sm:inline">{{ entry.collection.label }}</span>
                  <span class="w-16 shrink-0 whitespace-nowrap text-right text-xs text-muted">
                    <ConsoleRelativeTime v-if="entry.change.updatedAt" :value="entry.change.updatedAt" />
                  </span>
                </RouterLink>
              </li>
            </ul>
            <p v-if="pending.length > 12" class="text-xs text-dimmed tabular-nums">And {{ pending.length - 12 }} more. Each collection lists all of its changes.</p>
          </section>

          <section aria-labelledby="collections" class="grid gap-2">
            <h2 id="collections" class="text-[13px] font-medium text-highlighted">Collections</h2>
            <div v-if="firstLoad && !collections.length" class="grid gap-px">
              <USkeleton v-for="index in 2" :key="index" class="h-11 rounded-md" />
            </div>
            <ul v-else class="divide-y divide-default overflow-hidden rounded-lg border border-default">
              <li v-for="collection in collections" :key="collection.name" class="flex h-11 items-center gap-3 px-3">
                <RouterLink :to="collectionRoute(collection.name)" class="flex min-w-0 flex-1 items-baseline gap-2 rounded-sm hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2">
                  <span class="truncate text-sm font-medium text-highlighted">{{ collection.label }}</span>
                  <span class="hidden truncate font-mono text-xs text-dimmed sm:inline">{{ collection.path }}</span>
                </RouterLink>
                <span class="shrink-0 text-xs text-muted tabular-nums">
                  {{ (overview?.collections.find(entry => entry.name === collection.name)?.states.published ?? 0) }} published
                </span>
                <UButton
                  v-if="collection.access.write"
                  :to="newRoute(collection.name)"
                  size="xs"
                  variant="outline"
                  icon="i-lucide-plus"
                  :label="consoleSingularLabel(collection.label)"
                  :aria-label="`New ${consoleSingularLabel(collection.label).toLowerCase()}`"
                />
              </li>
            </ul>
            <p v-if="collections.length && !writable.length" class="text-xs text-dimmed">You can read these collections but not edit them.</p>
          </section>
        </div>

        <section aria-labelledby="recent-activity" class="grid gap-2">
          <h2 id="recent-activity" class="text-[13px] font-medium text-highlighted">Recent activity</h2>
          <div v-if="firstLoad" class="grid gap-3">
            <USkeleton v-for="index in 5" :key="index" class="h-9 rounded-md" />
          </div>
          <p v-else-if="!overview?.activity.length" class="text-xs text-muted">Saves and publishes show here.</p>
          <ol v-else class="grid gap-3">
            <li v-for="entry in overview.activity" :key="entry.id" class="grid gap-0.5">
              <p class="min-w-0 text-[13px] text-muted">
                <span class="font-medium text-highlighted">{{ entry.author ?? "Someone" }}</span>
                {{ activityVerb(entry) }}
                <template v-if="entry.documents.length === 1">
                  <RouterLink
                    v-if="entry.action !== 'remove'"
                    :to="documentRoute(entry.documents[0]!.collection, entry.documents[0]!.id)"
                    class="text-highlighted underline decoration-(--ui-border-accented) underline-offset-2 hover:decoration-(--ui-text-muted)"
                  >{{ entry.documents[0]!.title }}</RouterLink>
                  <span v-else class="text-highlighted">{{ entry.documents[0]!.title }}</span>
                </template>
                <span v-else class="text-highlighted">{{ entry.documents.length }} documents</span>
              </p>
              <p class="flex min-w-0 gap-1.5 text-xs text-dimmed">
                <span class="shrink-0 whitespace-nowrap"><ConsoleRelativeTime :value="entry.createdAt" /></span>
                <span aria-hidden="true">·</span>
                <span class="truncate">{{ entry.documents.length === 1 ? collectionLabel(entry.documents[0]!.collection) : entry.documents.map(document => document.title).join(", ") }}</span>
              </p>
            </li>
          </ol>
        </section>
      </div>
    </div>
  </div>
</template>
