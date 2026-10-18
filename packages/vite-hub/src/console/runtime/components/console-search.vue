<script setup lang="ts">
import { defineShortcuts } from "@nuxt/ui/composables";
import { useCollection } from "vite-hub/source/client";
import { computed, inject, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { CommandPaletteGroup, CommandPaletteItem } from "@nuxt/ui"
import type { Collection } from "@vite-hub/source"
import type { AgentInvocationListItem } from "@vite-hub/ui"
import type { ConsoleDocumentOverview, ConsoleDocumentSearchResult, ConsoleDocumentState } from "../client/documents"
import type { ConsoleContributedSection, ConsoleDocumentCollection } from "../definitions"
import type { ConsoleSectionDetails, ConsoleSectionId } from "../sections"
import { consoleAppearanceKey, consoleAppearanceOptions, consoleAppearances, consoleDarkSchemeQuery } from "../client/appearance"
import { consoleDocumentStateColor, consoleDocumentStateLabel, consoleErrorMessage, consolePublishMismatches, consoleSingularLabel, createConsoleDocumentsClient } from "../client/documents"
import { publishConsoleDocumentChanges } from "../client/publish"
import { loadConsoleKVPages, requestConsole } from "../client/request"
import { loadConsoleNavigation, resolveConsoleSectionDetails } from "../client/sections"
import type { ConsoleNavigation } from "../client/sections"
import { relativeDuration } from "../client/time"
import { useConsoleToast } from "../client/toast"
import { encodeAgentRouteParam, resolveConsoleRouteName } from "../console-route"
import { parseConsoleSectionContent } from "../definitions"
import { consoleOverviewShortcut, consoleSectionDetails, consoleSectionPageRouteName, consoleSectionRouteName, consoleSectionShortcut, groupConsoleSections } from "../sections"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics";
import ConsoleSectionIcon from "./console-section-icon.vue";

interface ConsoleSearchFilter {
  search?: string;
}

interface ConsoleSearchItem {
  agentName?: string;
  context: string;
  excerpt?: string;
  id: string;
  status: AgentInvocationListItem["status"];
  updatedAt: string;
}

interface ConsoleDefinitionSearchItem {
  details: ConsoleSectionDetails
  file: string
  name: string
  section: ConsoleSectionId
  source: string
}

interface ConsoleKVSearchItem {
  key: string
  store: string
}

/** A document editor section that the user may open, with what search needs from it. */
interface ConsoleDocumentSearchSection {
  collections: ConsoleDocumentCollection[]
  details: ConsoleContributedSection
  overview?: ConsoleDocumentOverview
}

interface ConsoleDocumentSearchItem {
  collection: ConsoleDocumentCollection
  id: string
  section: ConsoleDocumentSearchSection
  state?: ConsoleDocumentState
  title: string
}

/** Extra words that find an item, such as `images` for Media (cmdk keyword aliases). */
const pageKeywords: Readonly<Record<string, readonly string[]>> = {
  "document-dashboard": ["home", "overview", "stats", "activity", "scheduled", "schedule"],
  "document-settings": ["settings", "site", "config", "configuration", "preferences", "singleton"],
  "media-library": ["images", "files", "uploads", "assets", "library"],
}

declare global {
  interface ViteHubCollectionMap {
    "vitehub-console-search": Collection<
      ConsoleSearchItem,
      ConsoleSearchFilter,
      ConsoleSearchFilter
    >;
  }
}

const props = defineProps<{
  /** Commands of the current page. Search lists them first, in an "Actions" group. */
  actions?: CommandPaletteItem[]
  agentNames?: string[]
  agentsBase: string
  definitionsBase: string
  kvBase: string
  searchBase: string
  sectionsBase: string
}>()
const route = useRoute()
const router = useRouter()
// The standalone Console provides its appearance. In a Nuxt host, UDashboardSearch shows the host color mode instead.
const appearance = inject(consoleAppearanceKey, undefined)
const open = ref(false)
const searchTerm = ref("")
const debouncedSearchTerm = ref("")
const sections = ref<ConsoleSectionId[]>([])
const installedNavigation = shallowRef<ConsoleNavigation>()
const discoveredAgentNames = ref<string[]>([])
const definitionItems = ref<ConsoleDefinitionSearchItem[]>([])
const kvItems = ref<ConsoleKVSearchItem[]>([])
const kvSearchTruncated = ref(false)
const navigationLoading = ref(true)
const navigationError = ref<unknown>()
const sessionSearchEnabled = ref(false)
let navigationRequest: AbortController | undefined
let sessionRequest: AbortController | undefined
let searchTimer: ReturnType<typeof setTimeout> | undefined
const emit = defineEmits<{ changed: []; selectPage: []; selectSession: [] }>()
const toast = useConsoleToast()
// Document actions live next to the section list, as `/api/_vitehub/console/documents`.
const documentsBase = props.sectionsBase.replace(/\/sections$/, "/documents")
const documentSections = ref<ConsoleDocumentSearchSection[]>([])
const documentResults = ref<ConsoleDocumentSearchItem[]>([])
const documentSearchPending = ref(false)
const documentSearchError = ref<unknown>()
const publishingAll = ref(false)
let documentRequest: AbortController | undefined

const agentsEnabled = computed(() => sections.value.includes("agents"));
const availableAgentNames = computed(() => props.agentNames ?? discoveredAgentNames.value);
const inactiveSearchFilter: ConsoleSearchFilter = {};
const searchFilter = computed<ConsoleSearchFilter>(() => {
  if (!agentsEnabled.value || !sessionSearchEnabled.value) return inactiveSearchFilter;
  return debouncedSearchTerm.value ? { search: debouncedSearchTerm.value } : {};
});
const sessionSearch = useCollection("vitehub-console-search", {
  filter: searchFilter,
  immediate: false,
  limit: 12,
  request: async (_endpoint, options) => {
    const controller = new AbortController()
    sessionRequest = controller
    const abort = () => controller.abort()
    options.signal?.addEventListener("abort", abort, { once: true })
    try {
      return await requestConsole(props.searchBase, { ...options, signal: controller.signal })
    }
    finally {
      options.signal?.removeEventListener("abort", abort)
      if (sessionRequest === controller) sessionRequest = undefined
    }
  },
});
const sessionItems = computed<CommandPaletteItem[]>(() =>
  sessionSearch.pending.value
    ? []
    : sessionSearch.items.value.map((item) => ({
        description: itemDescription(item),
        disabled: !item.agentName,
        icon: "i-lucide-message-square-text",
        label: item.excerpt || (item.agentName ? `${item.agentName} session` : "Agent Invocation"),
        onSelect: () => selectSession(item),
      })),
)
const definitionSearchItems = computed<CommandPaletteItem[]>(() =>
  definitionItems.value.map(item => ({
    description: `${item.details.label.slice(0, -1)} · ${item.file}`,
    icon: item.details.icon,
    label: item.name,
    section: item.section,
    slot: "section",
    onSelect: () => selectDefinition(item),
  })),
)
const kvSearchItems = computed<CommandPaletteItem[]>(() =>
  kvItems.value.map(item => ({
    description: item.store,
    icon: consoleSectionDetails.kv.icon,
    section: "kv",
    slot: "section",
    label: item.key || "(empty key)",
    onSelect: () => selectKVKey(item),
  })),
)
const paletteError = computed(() => navigationError.value || sessionSearch.error.value || documentSearchError.value)

function documentRoute(item: Pick<ConsoleDocumentSearchItem, "collection" | "id" | "section">) {
  return {
    name: resolveConsoleRouteName(route.name, consoleSectionRouteName(item.section.details.id)),
    params: { collection: item.collection.name, document: item.id.split("/") },
    query: {},
  }
}

/** ⌘ Enter or Ctrl Enter, and ⌘-click, open the item in a new tab. */
function opensNewTab(event?: Event): boolean {
  const original: unknown = event instanceof CustomEvent ? Reflect.get(Object(event.detail), "originalEvent") : event
  return original instanceof KeyboardEvent || original instanceof MouseEvent ? original.metaKey || original.ctrlKey : false
}

async function openLocation(location: Parameters<typeof router.push>[0], event?: Event): Promise<void> {
  open.value = false
  if (opensNewTab(event)) {
    window.open(router.resolve(location).href, "_blank", "noopener")
    return
  }
  emit("selectPage")
  await router.push(location)
}

function documentItem(item: ConsoleDocumentSearchItem): CommandPaletteItem {
  return {
    label: item.title,
    suffix: `${item.collection.label} · ${item.id}`,
    slot: "document",
    state: item.state,
    stateLabel: item.state ? consoleDocumentStateLabel(item.state) : undefined,
    onSelect: (event: Event) => void openLocation(documentRoute(item), event),
  }
}

// With no query, the Content group shows recently changed documents from the overview.
const recentDocumentItems = computed<ConsoleDocumentSearchItem[]>(() => {
  const seen = new Set<string>()
  return documentSections.value.flatMap(section => (section.overview?.activity ?? []).flatMap((entry) => {
    if (entry.action === "remove") return []
    return entry.documents.flatMap((document) => {
      const collection = section.collections.find(candidate => candidate.name === document.collection)
      const key = `${section.details.id}:${document.collection}/${document.id}`
      if (!collection || seen.has(key)) return []
      seen.add(key)
      const change = section.overview?.collections.find(candidate => candidate.name === document.collection)?.changes.find(candidate => candidate.id === document.id)
      return [{ collection, id: document.id, section, state: change?.state ?? "published", title: document.title }]
    })
  })).slice(0, 5)
})

const pendingPublish = computed(() => documentSections.value.flatMap(section => (section.overview?.collections ?? []).flatMap((entry) => {
  const collection = section.collections.find(candidate => candidate.name === entry.name)
  return collection?.access.publish ? entry.changes.map(change => ({ change, collection, section })) : []
})))

async function publishAll(): Promise<void> {
  const targets = pendingPublish.value
  if (publishingAll.value || !targets.length) return
  open.value = false
  publishingAll.value = true
  try {
    let count = 0
    for (const section of new Set(targets.map(entry => entry.section))) {
      const client = createConsoleDocumentsClient(documentsBase, section.details.id)
      count += await publishConsoleDocumentChanges(client, targets.filter(entry => entry.section === section).map(entry => ({ change: entry.change, collection: entry.collection.name })))
    }
    toast.show({ title: count === 1 ? "Change published" : `${count} changes published` })
  }
  catch (publishError) {
    const moved = consolePublishMismatches(publishError)
    toast.error(moved ? "A draft changed after search loaded it. Open search and publish again." : `Couldn't publish. ${consoleErrorMessage(publishError, "Try again.")}`)
  }
  finally {
    publishingAll.value = false
    emit("changed")
  }
}

const contentActions = computed<CommandPaletteItem[]>(() => [
  ...documentSections.value.flatMap(section => section.collections.filter(collection => collection.access.write && collection.kind !== "singleton").map((collection): CommandPaletteItem => {
    const noun = consoleSingularLabel(collection.label)
    return {
      icon: "i-lucide-plus",
      keywords: ["create", "add", "write", "draft", collection.name, collection.label],
      label: `New ${noun === "Document" ? `${collection.label} document` : noun.toLowerCase()}`,
      onSelect: (event: Event) => void openLocation({
        name: resolveConsoleRouteName(route.name, consoleSectionRouteName(section.details.id)),
        params: { collection: collection.name, document: [] },
        query: { new: "1" },
      }, event),
    }
  })),
  // A nested page lists what would publish, so the reader reviews it before confirming. Backspace goes back.
  ...(pendingPublish.value.length
    ? [{
        children: [
          {
            icon: "i-lucide-upload",
            label: pendingPublish.value.length === 1 ? "Publish 1 change" : `Publish ${pendingPublish.value.length} changes`,
            loading: publishingAll.value,
            onSelect: () => void publishAll(),
          },
          ...pendingPublish.value.map(({ change, collection, section }) => ({
            label: change.title,
            suffix: `${collection.label} · ${change.id}`,
            slot: "document",
            state: change.state,
            stateLabel: consoleDocumentStateLabel(change.state),
            onSelect: (event: Event) => void openLocation(change.state === "deleted"
              ? { name: resolveConsoleRouteName(route.name, consoleSectionRouteName(section.details.id)), params: { collection: collection.name, document: [] }, query: {} }
              : documentRoute({ collection, id: change.id, section }), event),
          })),
        ],
        icon: "i-lucide-upload",
        keywords: ["deploy", "release", "ship", "go live", "changes"],
        label: "Publish all changes",
        placeholder: "Review the changes, then publish…",
        suffix: String(pendingPublish.value.length),
      }]
    : []),
])

const themeActions = computed<CommandPaletteItem[]>(() => appearance
  ? [
      {
        icon: "i-lucide-sun-moon",
        keywords: ["dark", "light", "mode", "appearance", "theme"],
        label: "Toggle theme",
        onSelect: () => {
          const dark = appearance.preference.value === "dark" || (appearance.preference.value === "system" && window.matchMedia(consoleDarkSchemeQuery).matches)
          appearance.select(dark ? "light" : "dark")
        },
      },
      {
        children: consoleAppearances.map(option => ({
          active: appearance.preference.value === option,
          icon: consoleAppearanceOptions[option].icon,
          label: consoleAppearanceOptions[option].label,
          onSelect: () => appearance.select(option),
        })),
        icon: consoleAppearanceOptions[appearance.preference.value].icon,
        keywords: ["appearance", "system", "dark", "light"],
        label: "Change theme…",
        placeholder: "Choose a theme…",
      },
    ]
  : [])

/** Pages and collections of the document editor sections, after their section in the Go to group. */
function documentSectionItems(section: ConsoleSectionId): CommandPaletteItem[] {
  const entry = documentSections.value.find(candidate => candidate.details.id === section)
  const details = installedNavigation.value?.contributions[section]
  if (!details) return []
  return [
    // The Settings page shows once the section has a singleton.
    ...(details.pages ?? []).filter(page => page.view.kind !== "document-settings" || entry?.collections.some(collection => collection.kind === "singleton")).map(page => ({
      icon: page.icon,
      keywords: [...pageKeywords[page.view.kind] ?? []],
      label: page.label,
      suffix: details.label,
      onSelect: (event: Event) => void openLocation(page.index
        ? { name: resolveConsoleRouteName(route.name, consoleSectionRouteName(section)), params: { collection: "", document: [] }, query: {} }
        : { name: resolveConsoleRouteName(route.name, consoleSectionPageRouteName(section, page.id)), query: {} }, event),
    })),
    ...(entry?.collections ?? []).map(collection => ({
      icon: collection.kind === "singleton" ? "i-lucide-settings-2" : "i-lucide-files",
      keywords: collection.kind === "singleton" ? ["settings", "edit", collection.name, collection.path] : ["collection", "documents", collection.name],
      label: collection.label,
      suffix: collection.kind === "singleton" ? `${details.label} settings` : `${details.label} collection`,
      onSelect: (event: Event) => void openLocation({
        name: resolveConsoleRouteName(route.name, consoleSectionRouteName(section)),
        params: { collection: collection.name, document: [] },
        query: {},
      }, event),
    })),
  ]
}
const groups = computed<CommandPaletteGroup[]>(() => [
  ...(paletteError.value
    ? [{
        id: "error",
        items: [{
          description: errorMessage(paletteError.value),
          disabled: true,
          icon: "i-lucide-cloud-off",
          label: "Could not load Console search",
        }],
        ignoreFilter: true,
        label: "Search status",
      }]
    : []),
  // With a query, document matches lead: finding a document is what search is for most often.
  ...(debouncedSearchTerm.value && documentSections.value.length
    ? [documentGroup.value]
    : []),
  ...(props.actions?.length || contentActions.value.length || themeActions.value.length
    ? [{ id: "actions", items: [...props.actions ?? [], ...contentActions.value, ...themeActions.value], label: "Actions" }]
    : []),
  {
    id: "go-to",
    items: [
      {
        icon: "i-lucide-layout-grid",
        kbds: [...consoleOverviewShortcut],
        keywords: ["home", "sections", "start"],
        label: "Overview",
        onSelect: () => selectPage("vitehub-console"),
      },
      // Sections follow the rail order.
      ...groupConsoleSections(sections.value.map(id => ({ id }))).flat().flatMap(({ id: section }) => {
        const details = resolveConsoleSectionDetails(installedNavigation.value, section)
        const shortcut = consoleSectionShortcut(section)
        return details
          ? [{
              icon: details.icon,
              ...(shortcut ? { kbds: [...shortcut] } : {}),
              label: details.label,
              section,
              slot: "section",
              onSelect: () => selectPage(details.routeName),
            }, ...documentSectionItems(section)]
          : []
      }),
    ],
    label: "Go to",
  },
  ...(!debouncedSearchTerm.value && recentDocumentItems.value.length
    ? [{ id: "documents", ignoreFilter: true, items: recentDocumentItems.value.map(documentItem), label: "Recent documents" }]
    : []),
  ...(agentsEnabled.value && availableAgentNames.value.length
    ? [{
        id: "agents",
        items: availableAgentNames.value.map(name => ({
          icon: consoleSectionDetails.agents.icon,
          label: name,
          section: "agents",
          slot: "section",
          onSelect: () => selectAgent(name),
        })),
        label: "Agents",
      }]
    : []),
  ...(definitionSearchItems.value.length
    ? [{ id: "definitions", items: definitionSearchItems.value, label: "Definitions" }]
    : []),
  ...(kvSearchItems.value.length
    ? [{
        id: "kv",
        items: kvSearchItems.value,
        label: "KV keys",
      }]
    : []),
  ...(kvSearchTruncated.value
    ? [{
        id: "kv-status",
        ignoreFilter: true,
        items: [{ disabled: true, icon: "i-lucide-triangle-alert", label: "More matching keys may exist" }],
        label: "KV status",
      }]
    : []),
  ...(agentsEnabled.value
    ? [
        {
          id: "sessions",
          ignoreFilter: true,
          items: sessionItems.value,
          label: debouncedSearchTerm.value ? "Sessions" : "Recent sessions",
        },
      ]
    : []),
])
// Server-side matches, so the palette does not filter them again.
const documentGroup = computed<CommandPaletteGroup>(() => ({
  id: "documents",
  ignoreFilter: true,
  items: documentSearchPending.value && !documentResults.value.length
    ? [{ disabled: true, icon: "i-lucide-loader-circle", label: "Searching documents…" }]
    : documentResults.value.map(documentItem),
  label: "Content",
}))
const loading = computed(() =>
  navigationLoading.value || documentSearchPending.value || (agentsEnabled.value && sessionSearch.pending.value),
)

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error
    ? error.message
    : error
      ? "The console could not load this data."
      : undefined;
}

function itemDescription(item: ConsoleSearchItem): string {
  const updatedAt = new Date(item.updatedAt).valueOf();
  const age = Number.isFinite(updatedAt)
    ? `${relativeDuration(Math.max(0, Date.now() - updatedAt))} ago`
    : undefined;
  return [item.agentName, item.status, age, item.excerpt ? undefined : item.context]
    .filter(Boolean)
    .join(" · ");
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

/** Loads the collections and the overview of each document editor section, for its pages, actions, and recent documents. */
async function loadDocumentSections(installed: ConsoleSectionId[], signal: AbortSignal): Promise<void> {
  const sections = installed.flatMap((section) => {
    const details = installedNavigation.value?.contributions[section]
    return details?.view.kind === "document-editor" ? [details] : []
  })
  documentSections.value = await Promise.all(sections.map(async (details): Promise<ConsoleDocumentSearchSection> => {
    const client = createConsoleDocumentsClient(documentsBase, details.id)
    const [content, overview] = await Promise.all([
      requestConsole(props.definitionsBase, { query: { section: details.id }, signal }).then(value => parseConsoleSectionContent(value, details.id)),
      // Search still works when the overview fails; it only loses recent documents and Publish all changes.
      client.overview({ activity: 10 }).catch(() => undefined),
    ])
    const entry: ConsoleDocumentSearchSection = { collections: content?.kind === "document-editor" ? [...content.collections] : [], details }
    if (overview) entry.overview = overview
    return entry
  }))
}

async function searchDocuments(term: string): Promise<void> {
  documentRequest?.abort()
  documentResults.value = []
  documentSearchError.value = undefined
  if (!term || !documentSections.value.length) {
    documentSearchPending.value = false
    return
  }
  const controller = new AbortController()
  documentRequest = controller
  documentSearchPending.value = true
  try {
    const found = await Promise.all(documentSections.value.map(async section => (await createConsoleDocumentsClient(documentsBase, section.details.id).search(term, { limit: 8, signal: controller.signal }))
      .flatMap((result: ConsoleDocumentSearchResult) => {
        const collection = section.collections.find(candidate => candidate.name === result.collection)
        return collection ? [{ collection, id: result.id, section, state: result.state, title: result.title }] : []
      })))
    if (documentRequest !== controller) return
    documentResults.value = found.flat()
  }
  catch (error) {
    if (error instanceof Object && "name" in error && error.name === "AbortError") return
    if (documentRequest === controller) documentSearchError.value = error
  }
  finally {
    if (documentRequest === controller) {
      documentRequest = undefined
      documentSearchPending.value = false
    }
  }
}

async function loadContent(installed: ConsoleSectionId[], signal: AbortSignal): Promise<void> {
  await loadDocumentSections(installed, signal)
  const definitionSections = installed.flatMap((section) => {
    const details = resolveConsoleSectionDetails(installedNavigation.value, section)
    const catalog = section === "databases"
      || installedNavigation.value?.contributions[section]?.view.kind === "definition-catalog"
    return details && catalog ? [{ details, section }] : []
  })
  const catalogs = await Promise.all(definitionSections.map(async ({ details, section }) => ({
    details,
    section,
    value: record(await requestConsole(props.definitionsBase, {
      query: { section },
      signal,
    })),
  })))
  definitionItems.value = catalogs.flatMap(({ details, section, value }) =>
    Array.isArray(value?.definitions)
      ? value.definitions.flatMap((entry) => {
          const definition = record(entry)
          return typeof definition?.name === "string"
            && typeof definition.file === "string"
            && typeof definition.source === "string"
            ? [{ details, file: definition.file, name: definition.name, section, source: definition.source }]
            : []
        })
      : [],
  )

  if (installed.includes("kv")) {
    const query = { limit: 50 }
    const first = record(await requestConsole(props.kvBase, { query, signal }))
    const firstStore = typeof first?.store === "string" ? first.store : "default"
    const stores = strings(first?.stores)
    const remainingStores = stores.filter(store => store !== firstStore)
    const storesWithFirstPage = [firstStore, ...remainingStores]
    const results = await Promise.all(storesWithFirstPage.map((store, index) =>
      loadConsoleKVPages(props.kvBase, store, signal, index === 0 ? first : undefined, {
        limit: query.limit,
        maxPages: 10,
      }),
    ))
    kvItems.value = results.flatMap(({ pages }, index) =>
      pages.flatMap(value => strings(value.keys).map(key => ({ key, store: storesWithFirstPage[index]! }))),
    )
    kvSearchTruncated.value = results.some(result => result.truncated)
  }
  else kvSearchTruncated.value = false
}

async function loadNavigation(discoverContent = false): Promise<void> {
  navigationRequest?.abort()
  const controller = new AbortController()
  navigationRequest = controller
  navigationLoading.value = true
  if (discoverContent) {
    discoveredAgentNames.value = []
    definitionItems.value = []
    kvItems.value = []
    kvSearchTruncated.value = false
    documentSections.value = []
  }
  try {
    const navigation = await loadConsoleNavigation(props.sectionsBase)
    if (!navigation) throw viteHubErrorDiagnostics.VITE_HUB_R0106({ message: "Could not load Console navigation." })
    const installed = navigation.sections
    controller.signal.throwIfAborted()
    if (navigationRequest !== controller) return
    installedNavigation.value = navigation
    sections.value = [...new Set(installed)]

    if (discoverContent && props.agentNames === undefined && installed.includes("agents")) {
      const agentsValue = record(await requestConsole(props.agentsBase, { signal: controller.signal }))
      const names = Array.isArray(agentsValue?.agents)
        ? agentsValue.agents.filter((name): name is string => {
            return typeof name === "string" && Boolean(name.trim());
          })
        : [];
      if (navigationRequest !== controller) return;
      discoveredAgentNames.value = [...new Set(names)];
    }
    if (discoverContent) await loadContent(installed, controller.signal)
    navigationError.value = undefined
  }
  catch (error) {
    if (error instanceof Object && "name" in error && error.name === "AbortError") return
    if (navigationRequest === controller) navigationError.value = error
  }
  finally {
    if (navigationRequest === controller) {
      navigationRequest = undefined;
      navigationLoading.value = false;
    }
  }
}

async function selectPage(routeName: string): Promise<void> {
  open.value = false;
  emit("selectPage");
  await router.push({ name: resolveConsoleRouteName(route.name, routeName) });
}

async function selectAgent(name: string): Promise<void> {
  open.value = false;
  emit("selectSession");
  await router.push({
    name: resolveConsoleRouteName(route.name, "vitehub-console-agent"),
    params: { agent: encodeAgentRouteParam(name) },
  });
}

async function selectDefinition(item: ConsoleDefinitionSearchItem): Promise<void> {
  open.value = false
  await router.push({
    name: resolveConsoleRouteName(route.name, item.details.routeName),
    ...(item.details.routeName === consoleSectionDetails.databases.routeName
      ? { params: { database: item.name } }
      : { query: { definition: item.name } }),
  })
}

async function selectKVKey(item: ConsoleKVSearchItem): Promise<void> {
  open.value = false
  await router.push({
    name: resolveConsoleRouteName(route.name, consoleSectionDetails.kv.routeName),
    query: { key: item.key, store: item.store },
  })
}

async function selectSession(item: ConsoleSearchItem): Promise<void> {
  if (!item.agentName) return;
  open.value = false;
  emit("selectSession");
  await router.push({
    name: resolveConsoleRouteName(route.name, "vitehub-console-invocation"),
    params: { agent: encodeAgentRouteParam(item.agentName), invocation: item.id },
  });
}

watch(searchTerm, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = undefined
  if (!open.value) return
  searchTimer = setTimeout(() => {
    searchTimer = undefined
    if (open.value) debouncedSearchTerm.value = value.trim()
    if (open.value) void searchDocuments(debouncedSearchTerm.value)
  }, 150)
})

watch(open, async (value) => {
  if (!value) {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = undefined
    navigationRequest?.abort()
    sessionRequest?.abort()
    documentRequest?.abort()
    return
  }
  await loadNavigation(true);
  if (open.value && debouncedSearchTerm.value) void searchDocuments(debouncedSearchTerm.value)
  if (!open.value) return
  if (!agentsEnabled.value) return;
  const nextSearchTerm = searchTerm.value.trim()
  const searchChanged = debouncedSearchTerm.value !== nextSearchTerm
  debouncedSearchTerm.value = nextSearchTerm
  if (!sessionSearchEnabled.value) sessionSearchEnabled.value = true
  else if (!searchChanged) await sessionSearch.refresh()
});

// `/` opens search, as in GitHub and Linear. It does not run while an input has focus.
defineShortcuts({
  "/": () => {
    open.value = true
  },
})

/**
 * The listbox ignores Enter with a modifier, so ⌘ Enter and Ctrl Enter click the highlighted item with that modifier.
 * The item then opens its page in a new tab.
 */
function openHighlightedInNewTab(event: KeyboardEvent): void {
  if (!open.value || event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.isComposing) return
  const highlighted = document.querySelector('[role="dialog"] [role="option"][data-highlighted]')
  if (!(highlighted instanceof HTMLElement)) return
  event.preventDefault()
  highlighted.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: event.ctrlKey, metaKey: event.metaKey }))
}

// Server rendering and component tests mount search without a window.
const browserWindow = (): Window | undefined => ("window" in globalThis ? window : undefined)

onMounted(() => {
  browserWindow()?.addEventListener("keydown", openHighlightedInNewTab, true)
  void loadNavigation()
});

onBeforeUnmount(() => {
  browserWindow()?.removeEventListener("keydown", openHighlightedInNewTab, true);
  navigationRequest?.abort();
  sessionRequest?.abort();
  documentRequest?.abort();
  if (searchTimer) clearTimeout(searchTimer);
});
</script>

<template>
  <UDashboardSearch
    v-model:open="open"
    v-model:search-term="searchTerm"
    :groups="groups"
    :loading="loading"
    :fuse="{ fuseOptions: { keys: ['label', 'description', 'suffix', 'keywords'] } }"
    description="Run actions and search pages, documents, Agents, definitions, KV keys, and sessions."
    placeholder="Search the Console…"
    preserve-group-order
    title="Search console"
    :ui="{ root: 'flex-1', content: 'flex-1', footer: 'px-3 py-2' }"
  >
    <template #empty="{ searchTerm: value }">
      <div class="grid justify-items-center gap-2 px-6 py-10 text-center">
        <UIcon
          name="i-lucide-search-x"
          class="size-6 text-dimmed"
        />
        <p class="text-sm font-medium text-highlighted">
          No matches
        </p>
        <p class="text-xs text-muted">
          {{ value.trim() ? "Try a page, document, Agent, definition, key, or session." : "No Console results are available yet." }}
        </p>
      </div>
    </template>
    <!-- Items with the `section` slot show the same section icon as the rail and the Overview. -->
    <template #section-leading="{ item, ui }">
      <ConsoleSectionIcon :section="item.section" :icon="item.icon" :class="ui.itemLeadingIcon()" />
    </template>
    <!-- Documents lead with their state dot, as in the Content list. The label next to it is for screen readers. -->
    <template #document-leading="{ item }">
      <span class="flex size-5 shrink-0 items-center justify-center">
        <span
          class="size-2 rounded-full"
          :class="{
            success: 'bg-success',
            warning: 'bg-warning',
            error: 'bg-error',
            neutral: 'ring-1 ring-(--ui-text-dimmed) ring-inset',
          }[consoleDocumentStateColor(item.state ?? 'draft')]"
          aria-hidden="true"
        />
        <span v-if="item.stateLabel" class="sr-only">{{ item.stateLabel }}</span>
      </span>
    </template>
    <template #footer>
      <div class="vitehub-console__search-footer">
        <span><UKbd value="arrowup" size="sm" /><UKbd value="arrowdown" size="sm" /> Navigate</span>
        <span><UKbd value="enter" size="sm" /> Select</span>
        <span><UKbd value="meta" size="sm" /><UKbd value="enter" size="sm" /> New tab</span>
        <span><UKbd value="backspace" size="sm" /> Back</span>
        <span><UKbd value="escape" size="sm" /> Close</span>
        <span class="vitehub-console__search-footer-end"><UKbd value="g" size="sm" /> then a key to go to a page</span>
      </div>
    </template>
  </UDashboardSearch>
</template>

<style>
.vitehub-console__search-footer {
  align-items: center;
  color: var(--ui-text-dimmed);
  display: flex;
  flex-wrap: wrap;
  font-size: 0.75rem;
  gap: 1rem;
  width: 100%;
}

.vitehub-console__search-footer > span {
  align-items: center;
  display: inline-flex;
  gap: 0.25rem;
}

.vitehub-console__search-footer-end {
  margin-inline-start: auto;
}
</style>
