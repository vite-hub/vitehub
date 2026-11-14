<script setup lang="ts">
import { consoleDayTime } from "../client/format";
import { Status } from "@vite-hub/ui";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import {
  consoleDocumentScheduleHint,
  consoleDocumentScheduleTone,
  consoleDocumentStates,
  consoleDocumentStateColor,
  consoleDocumentStateLabel,
  consoleErrorMessage,
  consoleFixFieldsLabel,
  consolePublishedConflicts,
  consolePublishMismatches,
  consoleSingularLabel,
} from "../client/documents";
import { useConsoleDocumentSessions } from "../client/presence";
import { publishConsoleDocumentChanges } from "../client/publish";
import { useConsoleToast } from "../client/toast";
import { resolveConsoleRouteName } from "../console-route";
import { consoleSectionPageRouteName, consoleSectionRouteName } from "../sections";
import ConsolePageHeader from "./console-page-header.vue";
import ConsolePresenceAvatars from "./console-presence-avatars.vue";
import ConsoleRelativeTime from "./console-relative-time.vue";
import ConsoleSetupHint from "./console-setup-hint.vue";

import type { ConsoleDocumentActivity, ConsoleDocumentOverview, ConsoleDocumentPendingChange, ConsoleDocumentScheduledChange, ConsoleDocumentsClient, ConsoleDocumentState } from "../client/documents";
import type { ConsoleDocumentCollection, ConsoleDocumentSetup } from "../definitions";
import ConsoleSection from "./console-section.vue";
import ConsoleStatGrid from "./console-stat-grid.vue";
import ConsoleState from "./console-state.vue";

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
const router = useRouter();
const toast = useConsoleToast();
const publishing = ref(false);
const publishOpen = ref(false);
// Changes published in this view leave the list at once; the next overview confirms it.
const published = ref(new Set<string>());
watch(() => props.overview, () => {
  published.value = new Set();
});

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
  value: totals.value[state],
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


// Writers see the changes, but only collections they may publish count toward the Publish button.
// Drafts with field issues stay out of Publish: they would make the whole publish fail.
const publishable = computed(() => pending.value.filter(entry => entry.collection.access.publish && !entry.change.issues));
const blocked = computed(() => pending.value.filter(entry => entry.collection.access.publish && entry.change.issues).length);
const canPublishAny = computed(() => props.collections.some(collection => collection.access.publish));
// Singletons, such as site settings, have their own page and no New button.
const listed = computed(() => props.collections.filter(collection => collection.kind !== "singleton"));
const singletons = computed(() => props.collections.filter(collection => collection.kind === "singleton"));
const settingsRoute = computed(() => {
  const name = consoleSectionPageRouteName(props.section, "settings");
  return router.hasRoute(name) ? { name } : undefined;
});

function statesOf(names: readonly string[]): Record<ConsoleDocumentState, number> {
  const states: Record<ConsoleDocumentState, number> = { draft: 0, changed: 0, published: 0, deleted: 0 };
  for (const entry of props.overview?.collections ?? []) {
    if (!names.includes(entry.name)) continue;
    for (const state of consoleDocumentStates) states[state] += entry.states[state];
  }
  return states;
}

/** `5 published`, then the drafts and changes that wait for a publish, such as `2 drafts`. */
function collectionCounts(names: readonly string[]): Array<{ label: string, state: ConsoleDocumentState }> {
  const states = statesOf(names);
  return [
    ...(states.draft ? [{ label: states.draft === 1 ? "1 draft" : `${states.draft} drafts`, state: "draft" as const }] : []),
    ...(states.changed ? [{ label: `${states.changed} changed`, state: "changed" as const }] : []),
  ];
}

// Recent activity shows the latest entries first and the rest on request.
const activityLimit = 8;
const showAllActivity = ref(false);
const activity = computed(() => {
  const entries = props.overview?.activity ?? [];
  return showAllActivity.value ? entries : entries.slice(0, activityLimit);
});
const writable = computed(() => listed.value.filter(collection => collection.access.write));
const firstLoad = computed(() => props.loading && !props.overview);
// Without an overview the counts, the changes, and the activity are unknown, so the page shows the failure instead of zeros.
const failed = computed(() => Boolean(props.error) && !props.loading && !props.overview);
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
    const site = consolePublishedConflicts(publishError);
    if (site?.length) toast.error(`${site.length === 1 ? "1 document" : `${site.length} documents`} also changed on the site. Open ${site.length === 1 ? "it" : "each one"} to compare, then publish again.`);
    else if (moved) toast.error(moved.length === 1 ? "A draft changed after this page loaded. Refresh and publish again." : `${moved.length} drafts changed after this page loaded. Refresh and publish again.`, { label: "Refresh", onClick: () => emit("reload") });
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
        <UButton label="Publish" :loading="publishing" :aria-label="`Publish ${publishable.length} ${publishable.length === 1 ? 'change' : 'changes'}`">
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
              <UButton variant="ghost" label="Cancel" @click="publishOpen = false" />
              <UButton label="Publish all" :loading="publishing" @click="publishAll" />
            </div>
          </div>
        </template>
      </UPopover>
    </template>
  </ConsolePageHeader>

  <div class="min-h-0 flex-1 overflow-y-auto" :aria-busy="loading">
    <div class="vitehub-console-page grid grid-cols-1 gap-8">
      <ConsoleState v-if="failed" class="py-6" :error="error" title="Couldn't load the dashboard" :retry="() => emit('reload')" />

      <!-- Counts: the numbers lead and the labels follow quietly. -->
      <UCard v-else as="section" aria-label="Documents by state">
        <ConsoleStatGrid :items="stats" size="lg" :columns="4">
          <template #label="{ item }"><Status :tone="consoleDocumentStateColor(item.state)" :label="item.label" /></template>
          <template #value="{ item }">
            <!-- The height of the 24px count, so the card keeps its height when the counts arrive. -->
            <USkeleton v-if="firstLoad" class="my-1 h-6 w-10" />
            <span v-else :class="item.value ? '' : 'text-dimmed'">{{ item.value }}</span>
          </template>
        </ConsoleStatGrid>
      </UCard>

      <div class="grid grid-cols-1 items-start gap-8" :class="failed ? undefined : 'lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]'">
        <div class="grid grid-cols-1 gap-8">
          <ConsoleSection v-if="openNow.length" title="Open now" :count="openNow.length">
            <!-- These lists do not clip their rows, so the focus ring around a row stays visible. The end rows take the corners. -->
            <ul class="divide-y divide-default rounded-lg border border-default">
              <li v-for="entry in openNow.slice(0, 12)" :key="`${entry.collection.name}/${entry.id}`" class="first:*:rounded-t-md last:*:rounded-b-md">
                <RouterLink :to="documentRoute(entry.collection.name, entry.id)" class="flex h-11 items-center gap-3 px-3 hover:bg-elevated">
                  <span class="min-w-0 flex-1 truncate text-sm text-highlighted">{{ entry.title }}</span>
                  <span class="hidden truncate text-xs text-dimmed sm:inline">{{ entry.collection.label }}</span>
                  <ConsolePresenceAvatars :sessions="sessionsOf(entry.collection.name, entry.id)" :user="sessionUser" />
                </RouterLink>
              </li>
            </ul>
          </ConsoleSection>

          <ConsoleSection v-if="!failed" title="Needs publishing" :count="pending.length || undefined" :description="pending.length && !canPublishAny ? 'An editor publishes these.' : undefined">
            <!-- One line, the height of "Everything is published": most visits find nothing to publish. -->
            <USkeleton v-if="firstLoad" class="h-24" />
            <UEmpty v-else-if="!pending.length && noAccess" icon="i-lucide-lock" title="No one can read documents yet">
              <template #description><ConsoleSetupHint :hint="noAccess" /></template>
            </UEmpty>
            <UEmpty
              v-else-if="!pending.length"
              icon="i-lucide-circle-check"
              title="Everything is published"
              description="Drafts and edits show here until someone publishes them."
            />
            <ul v-else class="divide-y divide-default rounded-lg border border-default">
              <li v-for="entry in pending.slice(0, 12)" :key="`${entry.collection.name}/${entry.change.id}`" class="first:*:rounded-t-md last:*:rounded-b-md">
                <RouterLink
                  :to="entry.change.state === 'deleted' ? collectionRoute(entry.collection.name) : documentRoute(entry.collection.name, entry.change.id)"
                  class="vitehub-dashboard-row"
                  data-focus-inset
                >
                  <Status class="vitehub-dashboard-row__status" :tone="consoleDocumentStateColor(entry.change.state)" :label="consoleDocumentStateLabel(entry.change.state)" />
                  <span class="vitehub-dashboard-row__title flex items-center gap-2">
                    <span class="truncate" :class="{ 'text-muted line-through decoration-(--ui-text-dimmed)': entry.change.state === 'deleted' }">{{ entry.change.title }}</span>
                    <ConsolePresenceAvatars :sessions="sessionsOf(entry.collection.name, entry.change.id)" :user="sessionUser" variant="row" />
                  </span>
                  <span class="vitehub-dashboard-row__meta flex items-center gap-2">
                    <UTooltip v-if="entry.change.issues" :text="consoleFixFieldsLabel(entry.change.issues)">
                      <Status tone="error" :label="entry.change.issues === 1 ? '1 issue' : `${entry.change.issues} issues`" />
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
          </ConsoleSection>

          <ConsoleSection v-if="scheduled.length" title="Scheduled" :count="scheduled.length">
            <p v-if="setup?.schedule" class="text-xs text-muted"><ConsoleSetupHint :hint="setup.schedule" /></p>
            <ul class="divide-y divide-default rounded-lg border border-default">
              <li v-for="entry in scheduled.slice(0, 12)" :key="`${entry.collection.name}/${entry.item.id}`" class="first:*:rounded-t-md last:*:rounded-b-md">
                <RouterLink
                  :to="documentRoute(entry.collection.name, entry.item.id)"
                  class="vitehub-dashboard-row"
                  :title="consoleDocumentScheduleHint(entry.item.schedule, setup)"
                >
                  <Status class="vitehub-dashboard-row__status" :tone="consoleDocumentScheduleTone(entry.item.schedule)" :label="scheduleStatus[entry.item.schedule.status]" />
                  <span class="vitehub-dashboard-row__title flex items-center gap-2">
                    <span class="truncate">{{ entry.item.title }}</span>
                    <ConsolePresenceAvatars :sessions="sessionsOf(entry.collection.name, entry.item.id)" :user="sessionUser" variant="row" />
                  </span>
                  <span class="vitehub-dashboard-row__meta">{{ entry.collection.label }}</span>
                  <time class="vitehub-dashboard-row__time" :datetime="entry.item.schedule.at">{{ consoleDayTime(entry.item.schedule.at) }}</time>
                </RouterLink>
              </li>
            </ul>
            <p v-if="scheduled.length > 12" class="text-xs text-dimmed tabular-nums">And {{ scheduled.length - 12 }} more. Each collection's Scheduled tab lists all of them.</p>
          </ConsoleSection>

          <ConsoleSection title="Collections">
            <div v-if="firstLoad && !listed.length" class="grid gap-px">
              <USkeleton v-for="index in 2" :key="index" class="h-11" />
            </div>
            <UEmpty
              v-else-if="!listed.length && !singletons.length"
              icon="i-lucide-folder-lock"
              title="No collections you can read"
              description="Ask an admin for read access to a collection."
            />
            <!-- min-w-0 lets the grid narrow the list, so long names truncate instead of pushing the counts past the column. -->
            <ul v-else class="min-w-0 divide-y divide-default rounded-lg border border-default">
              <li v-for="collection in listed" :key="collection.name" class="flex h-11 items-center gap-3 px-3">
                <RouterLink :to="collectionRoute(collection.name)" class="flex min-w-0 flex-1 items-baseline gap-2 hover:text-highlighted">
                  <span class="truncate text-sm font-medium text-highlighted">{{ collection.label }}</span>
                  <span class="hidden truncate font-mono text-xs text-dimmed sm:inline">{{ collection.path }}</span>
                </RouterLink>
                <!-- Counts show only when the overview is known. While it loads, a placeholder holds their place. -->
                <USkeleton v-if="firstLoad" class="h-4 w-20" />
                <span v-else-if="overview" class="flex shrink-0 items-center gap-3 text-xs text-muted tabular-nums">
                  <Status v-for="count in collectionCounts([collection.name])" :key="count.state" class="hidden sm:inline-flex" :tone="consoleDocumentStateColor(count.state)" :label="count.label" />
                  <span>{{ statesOf([collection.name]).published }} published</span>
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
              <li v-if="singletons.length && settingsRoute" class="flex h-11 items-center gap-3 px-3">
                <RouterLink :to="settingsRoute" class="flex min-w-0 flex-1 items-baseline gap-2">
                  <span class="truncate text-sm font-medium text-highlighted">Settings</span>
                  <span class="hidden truncate text-xs text-dimmed sm:inline">{{ singletons.length === 1 ? "1 singleton" : `${singletons.length} singletons` }}</span>
                </RouterLink>
                <USkeleton v-if="firstLoad" class="h-4 w-20" />
                <span v-else-if="overview" class="flex shrink-0 items-center gap-3 text-xs text-muted tabular-nums">
                  <Status v-for="count in collectionCounts(singletons.map(entry => entry.name))" :key="count.state" class="hidden sm:inline-flex" :tone="consoleDocumentStateColor(count.state)" :label="count.label" />
                  <span>{{ statesOf(singletons.map(entry => entry.name)).published }} published</span>
                </span>
              </li>
            </ul>
            <p v-if="listed.length && !writable.length" class="text-xs text-dimmed">You can read these collections but not edit them.</p>
          </ConsoleSection>
        </div>

        <ConsoleSection v-if="!failed" title="Recent activity">
          <div v-if="firstLoad" class="grid gap-3">
            <USkeleton v-for="index in 5" :key="index" class="h-9" />
          </div>
          <UEmpty v-else-if="!overview?.activity.length" icon="i-lucide-history" title="No activity yet" description="Saves and publishes show here." />
          <ol v-else class="grid">
            <li v-for="entry in activity" :key="entry.id" class="grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 py-1">
              <p class="min-w-0 truncate text-[13px] text-muted" :title="entry.documents.length === 1 ? collectionLabel(entry.documents[0]!.collection) : entry.documents.map(document => document.title).join(', ')">
                <span :class="entry.author ? 'font-medium text-highlighted' : ''">{{ entry.author ?? "Someone" }}</span>
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
              <span class="text-xs whitespace-nowrap text-dimmed tabular-nums"><ConsoleRelativeTime :value="entry.createdAt" /></span>
            </li>
          </ol>
          <UButton
            v-if="(overview?.activity.length ?? 0) > activityLimit"
            variant="ghost"
            size="xs"
            class="w-fit"
            :label="showAllActivity ? 'Show less' : `Show all ${overview?.activity.length}`"
            :aria-expanded="showAllActivity"
            @click="showAllActivity = !showAllActivity"
          />
        </ConsoleSection>
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
  background: var(--ui-bg-elevated);
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
