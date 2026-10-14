<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { consoleErrorMessage, consoleListQueryFor, createConsoleDocumentsClient } from "../client/documents";
import { requestConsole } from "../client/request";
import { loadConsoleNavigation } from "../client/sections";
import { resolveConsoleRouteName } from "../console-route";
import { parseConsoleSectionContent } from "../definitions";
import { consoleSectionPageRouteName, consoleSectionPageSegment, consoleSectionRouteName, rememberConsoleSection } from "../sections";
import ConsoleDocumentDashboard from "./console-document-dashboard.vue";
import ConsoleDocumentEditor from "./console-document-editor.vue";
import ConsoleDocumentList from "./console-document-list.vue";
import ConsoleDocumentSettings from "./console-document-settings.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsoleMediaLibrary from "./console-media-library.vue";
import ConsoleSearch from "./console-search.vue";

import type { ConsoleDocumentOverview, ConsoleDocumentState } from "../client/documents";
import type { ConsoleContributedSection, ConsoleDocumentCollection, ConsoleSectionPage } from "../definitions";

/**
 * Document editor section: the section sidebar with its pages and collections, then the selected page, the documents of
 * the selected collection, or the editor of one document. Routes:
 *
 * - `/<section>`: the index page, such as the dashboard, or the first collection when the section has none.
 * - `/<section>/-/<page>`: another page, such as Media.
 * - `/<section>/<collection>/<document id>`: a collection and a document; `?new` opens an empty document.
 * - `/<section>/<singleton>`: the editor of a singleton, such as site settings, without a list. Singletons are listed on
 *   the Settings page instead of among the collections.
 */
const props = defineProps<{
  agentsBase: string;
  definitionsBase: string;
  /** Descriptor of the section. The owner package defines it. */
  details: ConsoleContributedSection;
  documentsBase: string;
  kvBase: string;
  searchBase: string;
  sectionsBase: string;
}>();

const route = useRoute();
const router = useRouter();
const section = computed(() => props.details.id);
const client = computed(() => createConsoleDocumentsClient(props.documentsBase, section.value));
const collections = ref<ConsoleDocumentCollection[]>([]);
const loading = ref(true);
const error = ref<unknown>();
const sidebarOpen = ref(false);
const sidebarCollapsed = ref(false);
// Bumps after a save, publish, or delete so the list and the counts reload.
const changes = ref(0);
// One overview request feeds the sidebar counts and the dashboard.
const overview = shallowRef<ConsoleDocumentOverview>();
const overviewLoading = ref(false);
const overviewError = ref<unknown>();
// Sections that the signed-in user may open, so a page can link to another section only when it is allowed.
const allowedSections = ref<string[]>([]);
let overviewRequest = 0;

function param(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.length ? value.join("/") : undefined;
  return String(value) === value && value ? value : undefined;
}

// Singletons, such as site settings, live on the Settings page; the sidebar lists the other collections.
const listCollections = computed(() => collections.value.filter(entry => entry.kind !== "singleton"));
const singletons = computed(() => collections.value.filter(entry => entry.kind === "singleton"));
// The Settings page shows once the section has a singleton the user may read.
const pages = computed<readonly ConsoleSectionPage[]>(() => (props.details.pages ?? []).filter(page => page.view.kind !== "document-settings" || singletons.value.length));
const settingsPage = computed(() => pages.value.find(page => page.view.kind === "document-settings"));
// A section with only singletons has no Collections heading.
const showCollections = computed(() => loading.value || Boolean(error.value) || listCollections.value.length > 0 || !singletons.value.length);
const indexPage = computed(() => pages.value.find(page => page.index));
const collectionName = computed(() => param(route.params.collection));
const documentId = computed(() => param(route.params.document));
const creating = computed(() => route.query.new !== undefined && !documentId.value);
const collection = computed(() => collections.value.find(entry => entry.name === collectionName.value));
// `/<section>/-/<unknown>` reaches the main route with `-` as the collection.
const unknownPage = computed(() => (collectionName.value === consoleSectionPageSegment ? documentId.value ?? "" : undefined));
const page = computed<ConsoleSectionPage | undefined>(() => {
  const id = route.meta.consolePage;
  if (String(id) === id) return (props.details.pages ?? []).find(entry => entry.id === id);
  return collectionName.value ? undefined : indexPage.value;
});
const counts = computed(() => new Map((overview.value?.collections ?? []).map(entry => [entry.name, entry.states])));
// Each collection gets the first letter of its label, or two letters when another collection starts with the same one.
const marks = computed(() => {
  const initials = listCollections.value.map(entry => entry.label.trim().slice(0, 1).toUpperCase());
  return new Map(listCollections.value.map((entry, index) => {
    const shared = initials.filter(initial => initial === initials[index]).length > 1;
    return [entry.name, shared ? `${initials[index]}${entry.label.trim().slice(1, 2).toLowerCase()}` : initials[index]!];
  }));
});
// Pages without a group lead the sidebar; grouped pages follow the collections, in the order their group first appears.
const leadingPages = computed(() => pages.value.filter(entry => !entry.group));
const pageGroups = computed(() => {
  const groups = new Map<string, ConsoleSectionPage[]>();
  for (const entry of pages.value) {
    if (entry.group) groups.set(entry.group, [...groups.get(entry.group) ?? [], entry]);
  }
  return [...groups].map(([label, items]) => ({ items, label }));
});

function mainRouteName(): string {
  return resolveConsoleRouteName(route.name, consoleSectionRouteName(section.value));
}

function pageRoute(entry: ConsoleSectionPage) {
  return entry.index
    ? { name: mainRouteName(), params: { collection: "", document: [] }, query: {} }
    : { name: resolveConsoleRouteName(route.name, consoleSectionPageRouteName(section.value, entry.id)), query: {} };
}

function collectionRoute(name: string) {
  return { name: mainRouteName(), params: { collection: name, document: [] }, query: consoleListQueryFor(name) };
}

/** `2 drafts, 1 changed` for the pills of one collection. */
function pendingLabel(states: Record<ConsoleDocumentState, number> | undefined): string | undefined {
  if (!states) return undefined;
  const parts = [states.draft && `${states.draft} ${states.draft === 1 ? "draft" : "drafts"}`, states.changed && `${states.changed} changed`, states.deleted && `${states.deleted} deleted`].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}
/** The document the editor opens: the route id, or the one document of a singleton. */
const editorDocumentId = computed(() => (collection.value?.kind === "singleton" ? collection.value.document : documentId.value));

async function loadCollections(): Promise<void> {
  loading.value = true;
  try {
    const content = parseConsoleSectionContent(
      await requestConsole(props.definitionsBase, { query: { section: section.value } }),
      section.value,
    );
    if (!content || content.kind !== "document-editor") throw new Error("The Console returned invalid collections.");
    collections.value = [...content.collections];
    error.value = undefined;
    // Without an index page, the section root opens the first collection.
    if (!collectionName.value && !page.value && collections.value[0]) {
      await router.replace({ name: mainRouteName(), params: { collection: collections.value[0].name, document: [] }, query: {} });
    }
  }
  catch (requestError) {
    error.value = requestError;
  }
  finally {
    loading.value = false;
  }
}

async function loadOverview(): Promise<void> {
  const current = ++overviewRequest;
  overviewLoading.value = true;
  try {
    const result = await client.value.overview();
    if (current !== overviewRequest) return;
    overview.value = result;
    overviewError.value = undefined;
  }
  catch (requestError) {
    if (current === overviewRequest) overviewError.value = requestError;
  }
  finally {
    if (current === overviewRequest) overviewLoading.value = false;
  }
}

function reload(): void {
  void loadCollections();
  void loadOverview();
}

onMounted(() => {
  rememberConsoleSection(section.value);
  reload();
  void loadConsoleNavigation(props.sectionsBase).then((navigation) => {
    allowedSections.value = navigation?.sections ?? [];
  });
});

watch(section, () => {
  rememberConsoleSection(section.value);
  collections.value = [];
  overview.value = undefined;
  reload();
});
watch(changes, () => void loadOverview());
</script>

<template>
  <ConsoleFrame :active="section" :sections-base="sectionsBase">
    <UDashboardSidebar
      id="console-navigation"
      v-model:open="sidebarOpen"
      v-model:collapsed="sidebarCollapsed"
      class="vitehub-console__nav"
      :default-size="15"
      :collapsed-size="3.5"
      :min-size="12"
      :max-size="24"
      :menu="{ title: details.label, description: details.description }"
      :ui="{ body: 'gap-0 overflow-hidden p-0' }"
      collapsible
      resizable
    >
      <template #header="{ collapsed }">
        <div v-if="!collapsed" class="vitehub-console__panel-title">
          <span class="min-w-0 flex-1 truncate">{{ details.label }}</span>
          <UTooltip text="Reload">
            <UButton aria-label="Reload collections and counts" icon="i-lucide-refresh-cw" size="xs" variant="ghost" :loading="loading" @click="reload" />
          </UTooltip>
          <UTooltip text="Collapse sidebar">
            <UDashboardSidebarCollapse class="hidden lg:inline-flex" size="xs" aria-label="Collapse sidebar" />
          </UTooltip>
        </div>
        <UTooltip v-else text="Expand sidebar" :content="{ side: 'right' }">
          <UDashboardSidebarCollapse class="mx-auto" size="sm" aria-label="Expand sidebar" />
        </UTooltip>
      </template>

      <template #default="{ collapsed }">
        <nav class="vitehub-console__section-nav" :class="{ 'is-collapsed': collapsed }" :aria-label="details.label">
          <UTooltip v-for="entry in leadingPages" :key="entry.id" :text="entry.label" :content="{ side: 'right' }" :disabled="!collapsed">
            <RouterLink
              :to="pageRoute(entry)"
              class="vitehub-console__section-link"
              :aria-current="page?.id === entry.id ? 'page' : undefined"
              :aria-label="collapsed ? entry.label : undefined"
              @click="sidebarOpen = false"
            >
              <UIcon :name="entry.icon" class="vitehub-console__section-icon" aria-hidden="true" />
              <span v-if="!collapsed" class="truncate">{{ entry.label }}</span>
            </RouterLink>
          </UTooltip>

          <p v-if="!collapsed && pages.length && showCollections" class="vitehub-console__section-heading">Collections</p>
          <div v-else-if="pages.length && showCollections" class="vitehub-console__section-rule" aria-hidden="true" />
          <div v-if="!collapsed && error" class="px-1 pb-2">
            <UAlert
              color="error"
              variant="subtle"
              icon="i-lucide-cloud-off"
              title="Couldn't load collections"
              :description="consoleErrorMessage(error)"
              :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', color: 'neutral', variant: 'outline', onClick: loadCollections }]"
            />
          </div>
          <template v-else-if="loading && !collections.length">
            <USkeleton v-for="index in 3" :key="index" class="my-0.5 h-8 rounded-md" />
          </template>
          <template v-else-if="listCollections.length">
            <UTooltip
              v-for="entry in listCollections"
              :key="entry.name"
              :text="collapsed ? [entry.label, pendingLabel(counts.get(entry.name))].filter(Boolean).join(' · ') : pendingLabel(counts.get(entry.name)) ?? ''"
              :content="{ side: 'right' }"
              :disabled="!collapsed && !pendingLabel(counts.get(entry.name))"
            >
              <RouterLink
                :to="collectionRoute(entry.name)"
                class="vitehub-console__section-link"
                :aria-current="!page && entry.name === collectionName ? 'page' : undefined"
                :aria-label="collapsed ? entry.label : undefined"
                @click="sidebarOpen = false"
              >
                <!-- Collections have no icon of their own, so a monogram marks each one, also when the sidebar is collapsed. -->
                <span class="vitehub-console__collection-mark" aria-hidden="true">{{ marks.get(entry.name) }}</span>
                <template v-if="!collapsed">
                  <span class="min-w-0 flex-1 truncate">{{ entry.label }}</span>
                  <span v-if="!entry.access.write" class="vitehub-console__section-hint">Read-only</span>
                  <span v-else-if="counts.get(entry.name)" class="vitehub-console__pills">
                    <span v-if="counts.get(entry.name)!.draft" class="vitehub-console__pill">
                      <span class="vitehub-console__pill-dot is-draft" aria-hidden="true" />{{ counts.get(entry.name)!.draft }}
                      <span class="sr-only">{{ counts.get(entry.name)!.draft === 1 ? "draft" : "drafts" }}</span>
                    </span>
                    <span v-if="counts.get(entry.name)!.changed + counts.get(entry.name)!.deleted" class="vitehub-console__pill">
                      <span class="vitehub-console__pill-dot is-changed" aria-hidden="true" />{{ counts.get(entry.name)!.changed + counts.get(entry.name)!.deleted }}
                      <span class="sr-only">changed</span>
                    </span>
                  </span>
                </template>
                <span v-else-if="pendingLabel(counts.get(entry.name))" class="vitehub-console__collapsed-dot" aria-hidden="true" />
              </RouterLink>
            </UTooltip>
          </template>
          <p v-else-if="!collapsed && !singletons.length" class="px-2 py-1.5 text-xs text-muted">
            No collections you can read.
          </p>

          <template v-for="group in pageGroups" :key="group.label">
            <p v-if="!collapsed" class="vitehub-console__section-heading">{{ group.label }}</p>
            <div v-else class="vitehub-console__section-rule" aria-hidden="true" />
            <UTooltip v-for="entry in group.items" :key="entry.id" :text="entry.label" :content="{ side: 'right' }" :disabled="!collapsed">
              <RouterLink
                :to="pageRoute(entry)"
                class="vitehub-console__section-link"
                :aria-current="page?.id === entry.id || (!page && entry.view.kind === 'document-settings' && collection?.kind === 'singleton') ? 'page' : undefined"
                :aria-label="collapsed ? entry.label : undefined"
                @click="sidebarOpen = false"
              >
                <UIcon :name="entry.icon" class="vitehub-console__section-icon" aria-hidden="true" />
                <span v-if="!collapsed" class="truncate">{{ entry.label }}</span>
              </RouterLink>
            </UTooltip>
          </template>
        </nav>
      </template>
    </UDashboardSidebar>

    <ConsoleSearch
      :agents-base="agentsBase"
      :definitions-base="definitionsBase"
      :kv-base="kvBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
      @changed="changes++"
    />

    <UDashboardPanel :id="`${section}-documents`" :ui="{ body: 'min-h-0 overflow-hidden p-0 gap-0' }">
      <ConsoleDocumentDashboard
        v-if="page?.view.kind === 'document-dashboard'"
        :client="client"
        :collections="collections"
        :error="overviewError ?? error"
        :label="page.label"
        :loading="overviewLoading || loading"
        :overview="overview"
        :section="section"
        @changed="changes++"
        @reload="reload"
      />
      <ConsoleDocumentSettings
        v-else-if="page?.view.kind === 'document-settings'"
        :error="error"
        :label="page.label"
        :loading="loading"
        :overview="overview"
        :section="section"
        :singletons="singletons"
        @reload="reload"
      />
      <ConsoleMediaLibrary
        v-else-if="page?.view.kind === 'media-library'"
        :blob-allowed="allowedSections.includes('blob')"
        :label="page.label"
      />
      <template v-else-if="unknownPage !== undefined">
        <UDashboardNavbar :ui="{ root: 'border-b border-default' }" :title="details.label" />
        <UEmpty
          class="min-h-0 flex-1"
          variant="naked"
          icon="i-lucide-file-question"
          :title="unknownPage ? `No page named ${unknownPage}` : 'No page here'"
          :description="`${details.label} has no such page.`"
          :actions="[{ label: `Open ${indexPage?.label ?? details.label}`, color: 'neutral', variant: 'outline', to: indexPage ? pageRoute(indexPage) : { name: mainRouteName() } }]"
        />
      </template>
      <template v-else-if="collection && (editorDocumentId || creating)">
        <ConsoleDocumentEditor
          :key="`${collection.name}/${editorDocumentId ?? '~new'}`"
          :client="client"
          :collection="collection"
          :document-id="editorDocumentId"
          :parent="collection.kind === 'singleton' && settingsPage ? { label: settingsPage.label, to: pageRoute(settingsPage) } : undefined"
          :changes="changes"
          @changed="changes++"
        />
      </template>
      <template v-else-if="collection">
        <ConsoleDocumentList :key="collection.name" :client="client" :collection="collection" :changes="changes" @changed="changes++" />
      </template>
      <template v-else-if="!loading && collectionName && !error">
        <UDashboardNavbar :ui="{ root: 'border-b border-default' }" :title="details.label" />
        <UEmpty
          class="min-h-0 flex-1"
          icon="i-lucide-folder-x"
          :title="`No collection named ${collectionName}`"
          description="It does not exist, or you cannot read its drafts."
          :actions="collections[0] ? [{ label: `Open ${collections[0].label}`, to: collectionRoute(collections[0].name) }] : []"
        />
      </template>
      <template v-else>
        <UDashboardNavbar :ui="{ root: 'border-b border-default' }" :title="details.label" />
        <div class="flex min-h-0 flex-1 items-center justify-center">
          <UIcon v-if="loading" name="i-lucide-loader-circle" class="size-4 animate-spin text-muted" />
          <UEmpty
            v-else
            :icon="details.icon"
            title="Nothing to edit yet"
            :description="details.view.notice"
          />
        </div>
      </template>
    </UDashboardPanel>
  </ConsoleFrame>
</template>

<style>
/*
 * The section sidebar: pages, a Collections heading, and grouped pages. Rows match the rail: 2rem tall, 13px labels, a
 * quiet background on hover and a stronger one on the current page. Rows change at once, without a transition (Rauno:
 * no motion on menus used many times a day).
 */
.vitehub-console__section-nav {
  display: grid;
  gap: 1px;
  overflow-y: auto;
  padding: 0 0.5rem 0.75rem;
}

.vitehub-console__section-link {
  align-items: center;
  border-radius: 0.375rem;
  color: var(--ui-text-muted);
  display: flex;
  font-size: 0.8125rem;
  font-weight: 500;
  gap: 0.5rem;
  height: 2rem;
  min-width: 0;
  padding-inline: 0.5rem;
  position: relative;
}

.vitehub-console__section-link:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text);
}

.vitehub-console__section-link[aria-current="page"] {
  background: var(--ui-bg-accented);
  color: var(--ui-text-highlighted);
}

.vitehub-console__section-link:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: -2px;
}

.vitehub-console__section-nav.is-collapsed .vitehub-console__section-link {
  justify-content: center;
  padding-inline: 0;
}

.vitehub-console__section-icon {
  flex-shrink: 0;
  height: 1rem;
  width: 1rem;
}

/* A collection monogram sits in the same 16px box as a page icon. */
.vitehub-console__collection-mark {
  align-items: center;
  border: 1px solid var(--ui-border-accented);
  border-radius: 0.25rem;
  display: inline-flex;
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 0.625rem;
  font-weight: 600;
  height: 1rem;
  justify-content: center;
  line-height: 1;
  min-width: 1rem;
  padding-inline: 0.125rem;
}

.vitehub-console__section-link[aria-current="page"] .vitehub-console__collection-mark {
  border-color: var(--ui-text-muted);
  color: var(--ui-text-highlighted);
}

.vitehub-console__section-heading {
  color: var(--ui-text-dimmed);
  font-size: 0.75rem;
  font-weight: 500;
  padding: 0.75rem 0.5rem 0.25rem;
}

.vitehub-console__section-rule {
  border-top: 1px solid var(--ui-border);
  margin: 0.375rem 0.5rem;
}

.vitehub-console__section-hint {
  color: var(--ui-text-dimmed);
  font-size: 0.75rem;
  font-weight: 400;
}

/* Counts are quiet: muted tabular numbers behind a status dot, no filled badge. */
.vitehub-console__pills {
  display: inline-flex;
  flex-shrink: 0;
  gap: 0.5rem;
}

.vitehub-console__pill {
  align-items: center;
  color: var(--ui-text-dimmed);
  display: inline-flex;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  font-weight: 400;
  gap: 0.25rem;
}

.vitehub-console__pill-dot {
  border-radius: 999px;
  height: 0.375rem;
  width: 0.375rem;
}

.vitehub-console__pill-dot.is-draft {
  box-shadow: inset 0 0 0 1px var(--ui-text-dimmed);
}

.vitehub-console__pill-dot.is-changed {
  background: var(--ui-warning);
}

.vitehub-console__collapsed-dot {
  background: var(--ui-warning);
  border-radius: 999px;
  height: 0.375rem;
  position: absolute;
  right: 0.375rem;
  top: 0.375rem;
  width: 0.375rem;
}
</style>
