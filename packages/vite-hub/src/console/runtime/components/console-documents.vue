<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { consoleErrorMessage, consoleListQueryFor, createConsoleDocumentsClient } from "../client/documents";
import { provideConsoleMediaPicker } from "../client/media";
import { consoleMediaBase, consoleMediaTransformable, consoleMediaUrl, consoleMediaVariantUrl, createConsoleMediaClient, isConsoleMediaPathname } from "../client/media-library";
import { isConsoleSignInRequired, requestConsole } from "../client/request";
import { resolveConsoleRouteName } from "../console-route";
import { parseConsoleSectionContent } from "../definitions";
import { consoleSectionPageRouteName, consoleSectionPageSegment, consoleSectionRouteName, rememberConsoleSection } from "../sections";
import ConsoleDocumentDashboard from "./console-document-dashboard.vue";
import ConsoleDocumentEditor from "./console-document-editor.vue";
import ConsoleDocumentList from "./console-document-list.vue";
import ConsoleDocumentSettings from "./console-document-settings.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsoleMediaLibrary from "./console-media-library.vue";
import ConsoleMediaPicker from "./console-media-picker.vue";
import ConsolePageHeader from "./console-page-header.vue";
import ConsoleSearch from "./console-search.vue";
import ConsoleSetupHint from "./console-setup-hint.vue";

import type { ConsoleDocumentOverview, ConsoleDocumentState } from "../client/documents";
import type { ConsoleMediaInfo } from "../client/media-library";
import type { ConsoleContributedSection, ConsoleDocumentCollection, ConsoleDocumentSetup, ConsoleSectionPage } from "../definitions";

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
// What the project lacks for some features, such as an access policy or a runner for scheduled publishes.
const setup = shallowRef<ConsoleDocumentSetup>();
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
let overviewRequest = 0;

// The media library of the section, when it has a Media page: the page itself, and the picker of the editor's images and
// Blob reference fields. The section's pages are fixed for its lifetime, so the picker is provided once.
const mediaClient = computed(() => createConsoleMediaClient(consoleMediaBase(props.documentsBase), section.value));
const hasMedia = (props.details.pages ?? []).some(entry => entry.view.kind === "media-library");
const mediaPicker = ref<InstanceType<typeof ConsoleMediaPicker>>();
const mediaInfo = shallowRef<ConsoleMediaInfo>();
// The editor waits for the served URL, so stored pathnames show as images on the first render.
const mediaPending = ref(hasMedia);
if (hasMedia) {
  provideConsoleMediaPicker({
    pick: request => mediaPicker.value?.pick(request) ?? Promise.resolve([]),
    resolveSrc: src => (isConsoleMediaPathname(src) ? consoleMediaUrl(mediaInfo.value?.served, src) : undefined),
    async describe(reference) {
      const file = await mediaClient.value.get(reference.pathname).catch(() => undefined);
      if (!file) return undefined;
      const url = file.url ?? consoleMediaUrl(mediaInfo.value?.served, file.pathname);
      const thumbnail = url && consoleMediaTransformable(file.contentType) ? consoleMediaVariantUrl(url, { fit: "cover", height: 96, version: file.updatedAt, width: 96 }) : url;
      return { ...(file.alt ? { alt: file.alt } : {}), ...(file.color ? { color: file.color } : {}), ...(file.focal ? { focal: file.focal } : {}), ...(file.width ? { width: file.width } : {}), ...(file.height ? { height: file.height } : {}), ...(thumbnail ? { thumbnail } : {}) };
    },
    async updateAlt(reference, alt) {
      await mediaClient.value.update(reference.pathname, { alt: alt || null });
    },
  });
}

async function loadMediaInfo(): Promise<void> {
  if (!hasMedia) return;
  try {
    mediaInfo.value = await mediaClient.value.info();
  }
  catch {
    // Without media access the picker falls back to showing sources as written.
  }
  finally {
    mediaPending.value = false;
  }
}

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
    setup.value = content.setup;
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
  void loadMediaInfo();
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
          <div v-if="!collapsed && error && isConsoleSignInRequired(error)" class="px-1 pb-2">
            <UAlert
              color="neutral"
              variant="subtle"
              icon="i-lucide-log-in"
              title="Sign in to edit"
              description="You are not signed in, or your session ended. Sign in, then reload."
              :actions="[{ label: 'Reload', icon: 'i-lucide-refresh-cw', color: 'neutral', variant: 'outline', onClick: reload }]"
            />
          </div>
          <div v-else-if="!collapsed && error" class="px-1 pb-2">
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
          <p v-else-if="!collapsed && !singletons.length && setup?.access" class="px-2 py-1.5 text-xs leading-relaxed text-muted">
            <ConsoleSetupHint :hint="setup.access" />
          </p>
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
        :setup="setup"
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
        :client="mediaClient"
        :label="page.label"
        :section="section"
      />
      <template v-else-if="unknownPage !== undefined">
        <ConsolePageHeader :title="details.label" />
        <UEmpty
          class="min-h-0 flex-1"
          variant="naked"
          icon="i-lucide-file-question"
          :title="unknownPage ? `No page named ${unknownPage}` : 'No page here'"
          :description="`${details.label} has no such page.`"
          :actions="[{ label: `Open ${indexPage?.label ?? details.label}`, color: 'neutral', variant: 'outline', to: indexPage ? pageRoute(indexPage) : { name: mainRouteName() } }]"
        />
      </template>
      <template v-else-if="collection && (editorDocumentId || creating) && mediaPending">
        <ConsolePageHeader :title="collection.label" />
        <div class="flex min-h-0 flex-1 items-center justify-center">
          <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-muted" />
        </div>
      </template>
      <template v-else-if="collection && (editorDocumentId || creating)">
        <ConsoleDocumentEditor
          :key="`${collection.name}/${editorDocumentId ?? '~new'}`"
          :client="client"
          :collection="collection"
          :document-id="editorDocumentId"
          :parent="collection.kind === 'singleton' && settingsPage ? { label: settingsPage.label, to: pageRoute(settingsPage) } : undefined"
          :changes="changes"
          :setup="setup"
          @changed="changes++"
        />
      </template>
      <template v-else-if="collection">
        <ConsoleDocumentList :key="collection.name" :client="client" :collection="collection" :changes="changes" :setup="setup" @changed="changes++" />
      </template>
      <template v-else-if="!loading && collectionName && !error">
        <ConsolePageHeader :title="details.label" />
        <UEmpty
          class="min-h-0 flex-1"
          variant="naked"
          icon="i-lucide-folder-x"
          :title="`No collection named ${collectionName}`"
          description="It does not exist, or you cannot read its drafts."
          :actions="collections[0] ? [{ label: `Open ${collections[0].label}`, to: collectionRoute(collections[0].name) }] : []"
        />
      </template>
      <template v-else>
        <ConsolePageHeader :title="details.label" />
        <div class="flex min-h-0 flex-1 items-center justify-center">
          <UIcon v-if="loading" name="i-lucide-loader-circle" class="size-4 animate-spin text-muted" />
          <UEmpty
            v-else-if="setup?.access"
            variant="naked"
            icon="i-lucide-lock"
            title="No one can read documents yet"
          >
            <template #description>
              <ConsoleSetupHint :hint="setup.access" />
            </template>
          </UEmpty>
          <UEmpty
            v-else
            variant="naked"
            :icon="details.icon"
            title="Nothing to edit yet"
            :description="details.view.notice"
          />
        </div>
      </template>
    </UDashboardPanel>
    <ConsoleMediaPicker v-if="hasMedia" ref="mediaPicker" :client="mediaClient" :section="section" />
  </ConsoleFrame>
</template>
