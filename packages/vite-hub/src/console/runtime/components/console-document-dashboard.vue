<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute } from "vue-router";

import {
  consoleDocumentScheduleHint,
  consoleDocumentScheduleTone,
  consoleDocumentStates,
  consoleDocumentStateColor,
  consoleDocumentStateLabel,
  consoleErrorMessage,
  consoleFixFieldsLabel,
  consolePublishMismatches,
  consoleSingularLabel,
} from "../client/documents";
import { useConsoleDocumentSessions } from "../client/presence";
import { publishConsoleDocumentChanges } from "../client/publish";
import { useConsoleToast } from "../client/toast";
import { resolveConsoleRouteName } from "../console-route";
import { consoleSectionRouteName } from "../sections";
import ConsolePageHeader from "./console-page-header.vue";
import ConsolePresenceAvatars from "./console-presence-avatars.vue";
import ConsoleRelativeTime from "./console-relative-time.vue";
import ConsoleSetupHint from "./console-setup-hint.vue";
import ConsoleStatus from "./console-status.vue";

import type { ConsoleDocumentActivity, ConsoleDocumentOverview, ConsoleDocumentPendingChange, ConsoleDocumentScheduledChange, ConsoleDocumentsClient, ConsoleDocumentState } from "../client/documents";
import type { ConsoleDocumentCollection, ConsoleDocumentSetup } from "../definitions";

/**
 * The dashboard of a document editor section: counts by state, the changes that wait for a publish, the scheduled
 * publishes, recent activity, and a New button per collection. The section shell loads the overview once and shares it with the sidebar counts.
 */
const props = defineProps<{
  client: ConsoleDocumentsClient;
  collections: readonly ConsoleDocumentCollection[];
  error?: unknown;
  label: string;
  loading: boolean;
  overview?: ConsoleDocumentOverview;
  section: string;
  /** What the project lacks, such as an access policy. */
  setup?: ConsoleDocumentSetup;
}>();

const emit = defineEmits<{ changed: [], reload: [] }>();

const route = useRoute();
const toast = useConsoleToast();
const publishing = ref(false);
const publishOpen = ref(false);
// Changes published in this view leave the list at once; the next overview confirms it.
const published = ref(new Set<string>());

const byName = computed(() => new Map(props.collections.map(collection => [collection.name, collection])));
// Who has which document open, for the avatars on each row and the Open now list.
const { sessions: openSessions, of: sessionsOf, user: sessionUser } = useConsoleDocumentSessions({ client: props.client });
const openNow = computed(() => {
  const titles = new Map<string, string>();
  for (const entry of props.overview?.collections ?? []) {
    for (const change of entry.changes) titles.set(`${entry.name}/${change.id}`, change.title);
    for (const item of entry.scheduled) titles.set(`${entry.name}/${item.id}`, item.title);
  }
  const documents = new Map<string, { collection: ConsoleDocumentCollection, id: string, title: string }>();
  for (const session of openSessions.value) {
    const collection = byName.value.get(session.collection);
    const key = `${session.collection}/${session.id}`;
    if (session.self || !collection || documents.has(key)) continue;
    documents.set(key, { collection, id: session.id, title: titles.get(key) ?? (collection.kind === "singleton" ? collection.label : session.id) });
  }
  return [...documents.values()];
});
const totals = computed(() => {
  const totals: Record<ConsoleDocumentState, number> = { draft: 0, changed: 0, published: 0, deleted: 0 };
  for (const entry of props.overview?.collections ?? []) {
    for (const state of consoleDocumentStates) totals[state] += entry.states[state];
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
// Every scheduled publish across the collections, soonest first.
const scheduled = computed(() => (props.overview?.collections ?? [])
  .flatMap(entry => (entry.scheduled ?? []).map(item => ({ item, collection: byName.value.get(entry.name) })))
  .filter((entry): entry is { item: ConsoleDocumentScheduledChange, collection: ConsoleDocumentCollection } => Boolean(entry.collection))
  .sort((left, right) => left.item.schedule.at.localeCompare(right.item.schedule.at)));
const scheduleStatus = { failed: "Failed", overdue: "Overdue", pending: "Scheduled" } as const;

/** `Oct 20, 09:00` in the browser time zone. */
function scheduleTime(at: string): string {
  return new Date(at).toLocaleString(undefined, { day: "numeric", hour: "2-digit", hour12: false, minute: "2-digit", month: "short" });
}

// Writers see the changes, but only collections they may publish count toward the Publish button.
// Drafts with field issues stay out of Publish: they would make the whole publish fail.
const publishable = computed(() => pending.value.filter(entry => entry.collection.access.publish && !entry.change.issues));
const blocked = computed(() => pending.value.filter(entry => entry.collection.access.publish && entry.change.issues).length);
const canPublishAny = computed(() => props.collections.some(collection => collection.access.publish));
// Singletons, such as site settings, have their own page and no New button.
const listed = computed(() => props.collections.filter(collection => collection.kind !== "singleton"));
const writable = computed(() => listed.value.filter(collection => collection.access.write));
const firstLoad = computed(() => props.loading && !props.overview);
// Without an access policy no one reads anything, so "Everything is published" would not be true.
const noAccess = computed(() => !props.collections.length ? props.setup?.access : undefined);

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

const verbs = new Map([["publish", "published"], ["remove", "deleted"], ["restore", "restored"], ["save", "edited"]]);

function activityVerb(entry: ConsoleDocumentActivity): string {
  return verbs.get(entry.action) ?? "changed";
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
  <ConsolePageHeader :title="label">
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
              <template v-if="blocked"> {{ blocked === 1 ? "1 draft with field issues stays" : `${blocked} drafts with field issues stay` }} unpublished.</template>
            </p>
            <div class="flex justify-end gap-2">
              <UButton variant="ghost" size="sm" label="Cancel" @click="publishOpen = false" />
              <UButton size="sm" label="Publish all" :loading="publishing" @click="publishAll" />
            </div>
          </div>
        </template>
      </UPopover>
    </template>
  </ConsolePageHeader>

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
          <section v-if="openNow.length" aria-labelledby="open-now" class="grid gap-2">
            <h2 id="open-now" class="text-[13px] font-medium text-highlighted">
              Open now
              <span class="ms-1 font-normal text-dimmed tabular-nums">{{ openNow.length }}</span>
            </h2>
            <ul class="divide-y divide-default overflow-hidden rounded-lg border border-default">
              <li v-for="entry in openNow.slice(0, 12)" :key="`${entry.collection.name}/${entry.id}`">
                <RouterLink :to="documentRoute(entry.collection.name, entry.id)" class="flex h-11 items-center gap-3 px-3 hover:bg-elevated/60 focus-visible:outline-2 focus-visible:-outline-offset-2">
                  <span class="min-w-0 flex-1 truncate text-sm text-highlighted">{{ entry.title }}</span>
                  <span class="hidden truncate text-xs text-dimmed sm:inline">{{ entry.collection.label }}</span>
                  <ConsolePresenceAvatars :sessions="sessionsOf(entry.collection.name, entry.id)" :user="sessionUser" />
                </RouterLink>
              </li>
            </ul>
          </section>

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
            <div v-else-if="!pending.length && noAccess" class="rounded-lg border border-dashed border-default px-4 py-6 text-center">
              <p class="text-[13px] text-highlighted">No one can read documents yet</p>
              <p class="mt-1 text-xs text-muted"><ConsoleSetupHint :hint="noAccess" /></p>
            </div>
            <div v-else-if="!pending.length" class="rounded-lg border border-dashed border-default px-4 py-6 text-center">
              <p class="text-[13px] text-highlighted">Everything is published</p>
              <p class="mt-1 text-xs text-muted">Drafts and edits show here until someone publishes them.</p>
            </div>
            <ul v-else class="divide-y divide-default overflow-hidden rounded-lg border border-default">
              <li v-for="entry in pending.slice(0, 12)" :key="`${entry.collection.name}/${entry.change.id}`">
                <RouterLink
                  :to="entry.change.state === 'deleted' ? collectionRoute(entry.collection.name) : documentRoute(entry.collection.name, entry.change.id)"
                  class="vitehub-dashboard-row"
                >
                  <ConsoleStatus class="vitehub-dashboard-row__status" :tone="consoleDocumentStateColor(entry.change.state)" :label="consoleDocumentStateLabel(entry.change.state)" />
                  <span class="vitehub-dashboard-row__title flex items-center gap-2">
                    <span class="truncate" :class="{ 'text-muted line-through decoration-(--ui-text-dimmed)': entry.change.state === 'deleted' }">{{ entry.change.title }}</span>
                    <ConsolePresenceAvatars :sessions="sessionsOf(entry.collection.name, entry.change.id)" :user="sessionUser" variant="row" />
                  </span>
                  <span class="vitehub-dashboard-row__meta flex items-center gap-2">
                    <UTooltip v-if="entry.change.issues" :text="consoleFixFieldsLabel(entry.change.issues)">
                      <ConsoleStatus tone="error" :label="entry.change.issues === 1 ? '1 issue' : `${entry.change.issues} issues`" />
                    </UTooltip>
                    {{ entry.collection.label }}
                  </span>
                  <span class="vitehub-dashboard-row__time">
                    <ConsoleRelativeTime v-if="entry.change.updatedAt" :value="entry.change.updatedAt" />
                    <span v-else aria-hidden="true">—</span>
                  </span>
                </RouterLink>
              </li>
            </ul>
            <p v-if="pending.length > 12" class="text-xs text-dimmed tabular-nums">And {{ pending.length - 12 }} more. Each collection lists all of its changes.</p>
          </section>

          <section v-if="scheduled.length" aria-labelledby="scheduled" class="grid gap-2">
            <h2 id="scheduled" class="text-[13px] font-medium text-highlighted">
              Scheduled
              <span class="ms-1 font-normal text-dimmed tabular-nums">{{ scheduled.length }}</span>
            </h2>
            <p v-if="setup?.schedule" class="text-xs text-muted"><ConsoleSetupHint :hint="setup.schedule" /></p>
            <ul class="divide-y divide-default overflow-hidden rounded-lg border border-default">
              <li v-for="entry in scheduled.slice(0, 12)" :key="`${entry.collection.name}/${entry.item.id}`">
                <RouterLink
                  :to="documentRoute(entry.collection.name, entry.item.id)"
                  class="vitehub-dashboard-row"
                  :title="consoleDocumentScheduleHint(entry.item.schedule, setup)"
                >
                  <ConsoleStatus class="vitehub-dashboard-row__status" :tone="consoleDocumentScheduleTone(entry.item.schedule)" :label="scheduleStatus[entry.item.schedule.status]" />
                  <span class="vitehub-dashboard-row__title flex items-center gap-2">
                    <span class="truncate">{{ entry.item.title }}</span>
                    <ConsolePresenceAvatars :sessions="sessionsOf(entry.collection.name, entry.item.id)" :user="sessionUser" variant="row" />
                  </span>
                  <span class="vitehub-dashboard-row__meta">{{ entry.collection.label }}</span>
                  <time class="vitehub-dashboard-row__time" :datetime="entry.item.schedule.at">{{ scheduleTime(entry.item.schedule.at) }}</time>
                </RouterLink>
              </li>
            </ul>
            <p v-if="scheduled.length > 12" class="text-xs text-dimmed tabular-nums">And {{ scheduled.length - 12 }} more. Each collection's Scheduled tab lists all of them.</p>
          </section>

          <section aria-labelledby="collections" class="grid gap-2">
            <h2 id="collections" class="text-[13px] font-medium text-highlighted">Collections</h2>
            <div v-if="firstLoad && !listed.length" class="grid gap-px">
              <USkeleton v-for="index in 2" :key="index" class="h-11 rounded-md" />
            </div>
            <p v-else-if="!listed.length" class="text-xs text-muted">No collections you can read.</p>
            <ul v-else class="divide-y divide-default overflow-hidden rounded-lg border border-default">
              <li v-for="collection in listed" :key="collection.name" class="flex h-11 items-center gap-3 px-3">
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
                  :label="consoleSingularLabel(collection)"
                  :aria-label="`New ${consoleSingularLabel(collection).toLowerCase()}`"
                />
              </li>
            </ul>
            <p v-if="listed.length && !writable.length" class="text-xs text-dimmed">You can read these collections but not edit them.</p>
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
              <p class="line-clamp-2 min-w-0 text-[13px] text-muted">
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

<style>
/*
 * A row of the dashboard lists: status, title, collection, and time on one 44px line on wide screens. On a phone the
 * title takes the first line and the rest follows on a quiet second line, so titles are not cut to a few letters.
 */
.vitehub-dashboard-row {
  align-items: center;
  column-gap: 0.75rem;
  display: grid;
  grid-template-areas: "title title time" "status meta meta";
  grid-template-columns: auto minmax(0, 1fr) auto;
  min-height: 2.75rem;
  min-width: 0;
  padding: 0.5rem 0.75rem;
  row-gap: 0.125rem;
}

.vitehub-dashboard-row:hover {
  background: color-mix(in oklab, var(--ui-bg-elevated) 60%, transparent);
}

.vitehub-dashboard-row:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: -2px;
}

.vitehub-dashboard-row__status { grid-area: status; }

.vitehub-dashboard-row__title {
  color: var(--ui-text-highlighted);
  font-size: 0.875rem;
  grid-area: title;
  line-height: 1.25rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vitehub-dashboard-row__meta {
  color: var(--ui-text-dimmed);
  font-size: 0.75rem;
  grid-area: meta;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vitehub-dashboard-row__time {
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  grid-area: time;
  text-align: end;
  white-space: nowrap;
}

@media (min-width: 640px) {
  .vitehub-dashboard-row {
    grid-template-areas: "status title meta time";
    grid-template-columns: 5rem minmax(0, 1fr) auto 6rem;
    padding-block: 0;
  }
}
</style>
