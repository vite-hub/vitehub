<script setup lang="ts">
import { Command, CommandGroup, CommandGroupLabel, CommandInput, CommandItem, CommandList, CommandPage, createCommandController } from "@ui-sdk/vue/command";
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@ui-sdk/vue/dialog";
import { useShortcut, useShortcutHint } from "@ui-sdk/vue/shortcuts";
import { Status } from "@vite-hub/ui";
import { useCollection } from "vite-hub/source/client";
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { CommandActionDetails, CommandPagesChangeReason, CommandQueryChangeReason } from "@ui-sdk/vue/command"
import type { ConsoleCommand, ConsoleCommandGroup } from "../client/command-search"
import { filterConsoleCommandGroups } from "../client/command-search"
import type { Collection } from "@vite-hub/source"
import type { ConsoleDocumentOverview, ConsoleDocumentSearchResult, ConsoleDocumentState } from "../client/documents"
import type { ConsoleContributedSection, ConsoleDocumentCollection } from "../definitions"
import type { AgentInvocationListItem } from "./invocation"
import type { ConsoleSectionDetails, ConsoleSectionId } from "../sections"
import { consoleAddablePrimitives, openConsoleAddPrimitive } from "../client/add-primitive"
import { consoleAppearanceKey, consoleAppearanceOptions, consoleAppearances, consoleDarkSchemeQuery } from "../client/appearance"
import { consoleDocumentStateColor, consoleDocumentStateLabel, consoleErrorMessage, consolePublishMismatches, consoleSingularLabel, createConsoleDocumentsClient } from "../client/documents"
import { switchConsoleProject, useConsoleProjects } from "../client/project-session"
import { consoleProjectHost, consoleProjectName } from "../client/projects"
import { publishConsoleDocumentChanges } from "../client/publish"
import { loadConsoleKVPages, requestConsole } from "../client/request"
import { loadConsoleNavigation, resolveConsoleSectionDetails } from "../client/sections"
import type { ConsoleNavigation } from "../client/sections"
import { recentTimestamp } from "../client/format"
import { useConsoleToast } from "../client/toast"
import { encodeAgentRouteParam, resolveConsoleRouteName } from "../console-route"
import { parseConsoleSectionContent } from "../definitions"
import { consoleOverviewShortcut, consoleSectionDetails, consoleSectionPageRouteName, consoleSectionRouteName, consoleSectionShortcut, groupConsoleSections } from "../sections"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics";
import Icon from "./console-icon.vue";
import ConsoleSectionIcon from "./console-section-icon.vue";
import { resolveConsoleAgentCatalog } from "./console-agent-list";
import { invocationStatusLabel } from "./invocation/agent-invocation-list";

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
  actions?: ConsoleCommand[]
  agentNames?: string[]
  /** Agent names that appear only in invocation history. Search lists them apart from the Agents. */
  historicalAgentNames?: string[]
  agentsBase: string
  definitionsBase: string
  kvBase: string
  searchBase: string
  sectionsBase: string
}>()
const route = useRoute()
const router = useRouter()
// The standalone Console provides its appearance. Without it, search has no theme actions.
const appearance = inject(consoleAppearanceKey, undefined)
// console-search.vue mounts the palette open, the first time search opens.
const open = defineModel<boolean>("open", { default: false })
const searchTerm = ref("")
const debouncedSearchTerm = ref("")
const sections = ref<ConsoleSectionId[]>([])
const installedNavigation = shallowRef<ConsoleNavigation>()
const discoveredAgentNames = ref<string[]>([])
const discoveredHistoricalAgentNames = ref<string[]>([])
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
// Document actions live next to the section list, as `/_vitehub/api/documents`.
const documentsBase = props.sectionsBase.replace(/\/sections$/, "/documents")
const documentSections = ref<ConsoleDocumentSearchSection[]>([])
const documentResults = ref<ConsoleDocumentSearchItem[]>([])
const documentSearchPending = ref(false)
const documentSearchError = ref<unknown>()
const publishingAll = ref(false)
let documentRequest: AbortController | undefined

const agentsEnabled = computed(() => sections.value.includes("agents"));
const availableAgentNames = computed(() => props.agentNames ?? discoveredAgentNames.value);
const availableHistoricalAgentNames = computed(() =>
  props.agentNames ? props.historicalAgentNames ?? [] : discoveredHistoricalAgentNames.value,
);
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
const sessionItems = computed<ConsoleCommand[]>(() =>
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
const definitionSearchItems = computed<ConsoleCommand[]>(() =>
  definitionItems.value.map(item => ({
    description: `${item.details.label.slice(0, -1)} · ${item.file}`,
    icon: item.details.icon,
    label: item.name,
    kind: "section",
    onSelect: () => selectDefinition(item),
  })),
)
const kvSearchItems = computed<ConsoleCommand[]>(() =>
  kvItems.value.map(item => ({
    description: item.store,
    icon: consoleSectionDetails.kv.icon,
    kind: "section",
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

function documentItem(item: ConsoleDocumentSearchItem): ConsoleCommand {
  return {
    label: item.title,
    suffix: `${item.collection.label} · ${item.id}`,
    kind: "document",
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

const contentActions = computed<ConsoleCommand[]>(() => [
  ...documentSections.value.flatMap(section => section.collections.filter(collection => collection.access.write && collection.kind !== "singleton").map((collection): ConsoleCommand => {
    const noun = consoleSingularLabel(collection)
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
            kind: "document",
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

const themeActions = computed<ConsoleCommand[]>(() => appearance
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

// An `account` Console switches between the projects of the team.
const projects = useConsoleProjects()
const projectActions = computed<ConsoleCommand[]>(() => projects.mode !== "embedded"
  ? [{
      children: [
        ...projects.projects.value.map(project => ({
          active: project.id === projects.current.value?.id,
          icon: project.id === projects.current.value?.id ? "i-lucide-check" : "i-lucide-box",
          label: consoleProjectName(project),
          suffix: consoleProjectHost(project),
          onSelect: () => {
            if (project.id !== projects.current.value?.id) switchConsoleProject(project.id)
          },
        })),
        { icon: "i-lucide-link", label: "Link project", onSelect: () => { projects.linkOpen.value = true } },
      ],
      icon: "i-lucide-arrow-left-right",
      keywords: ["project", "projects", "app", "link", "change"],
      label: "Switch project…",
      placeholder: "Choose a project…",
    }]
  : [])

// "Add a primitive" opens the dialog at its list. With a query, "Set up <Primitive>" opens it at one primitive, so
// search finds a primitive that the app does not use yet.
const addPrimitiveItems = computed<ConsoleCommand[]>(() => {
  if (!installedNavigation.value) return []
  const add = (choice?: ConsoleSectionId) => {
    open.value = false
    openConsoleAddPrimitive(choice)
  }
  return [
    { icon: "i-lucide-plus", keywords: ["add", "enable", "install", "primitive", "vitehub add"], label: "Add a primitive…", onSelect: () => add() },
    ...(searchTerm.value.trim()
      ? consoleAddablePrimitives(sections.value).map(entry => ({
          description: entry.pitch,
          icon: entry.icon,
          keywords: ["add", "enable", entry.id, ...(entry.feature ? [entry.feature] : [])],
          label: `Set up ${entry.label}`,
          kind: "section" as const,
          onSelect: () => add(entry.id),
        }))
      : []),
  ]
})

/** Pages and collections of the document editor sections, after their section in the Go to group. */
function documentSectionItems(section: ConsoleSectionId): ConsoleCommand[] {
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
const groups = computed<ConsoleCommandGroup[]>(() => [
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
  ...(props.actions?.length || contentActions.value.length || projectActions.value.length || themeActions.value.length
    ? [{ id: "actions", items: [...props.actions ?? [], ...contentActions.value, ...projectActions.value, ...themeActions.value], label: "Actions" }]
    : []),
  {
    id: "go-to",
    items: [
      {
        icon: "i-lucide-gauge",
        kbds: [...consoleOverviewShortcut],
        keywords: ["home", "sections", "start"],
        label: "Overview",
        onSelect: () => selectPage("vitehub-console"),
      },
      // Sections follow the sidebar order.
      ...groupConsoleSections(sections.value.map(id => ({ id }))).flat().flatMap(({ id: section }) => {
        const details = resolveConsoleSectionDetails(installedNavigation.value, section)
        const shortcut = consoleSectionShortcut(section)
        return details
          ? [{
              icon: details.icon,
              ...(shortcut ? { kbds: [...shortcut] } : {}),
              label: details.label,
              kind: "section",
              onSelect: () => selectPage(details.routeName),
            }, ...documentSectionItems(section)]
          : []
      }),
    ],
    label: "Go to",
  },
  ...(addPrimitiveItems.value.length
    ? [{ id: "add-primitive", items: addPrimitiveItems.value, label: "Add to this app" }]
    : []),
  ...(!debouncedSearchTerm.value && recentDocumentItems.value.length
    ? [{ id: "documents", ignoreFilter: true, items: recentDocumentItems.value.map(documentItem), label: "Recent documents" }]
    : []),
  ...(agentsEnabled.value && availableAgentNames.value.length
    ? [{
        id: "agents",
        items: availableAgentNames.value.map(name => ({
          icon: consoleSectionDetails.agents.icon,
          label: name,
          kind: "section",
          onSelect: () => selectAgent(name),
        })),
        label: "Agents",
      }]
    : []),
  ...(agentsEnabled.value && availableHistoricalAgentNames.value.length
    ? [{
        id: "historical-agents",
        items: availableHistoricalAgentNames.value.map(name => ({
          icon: "i-lucide-history",
          label: name,
          onSelect: () => selectAgent(name),
        })),
        label: "Invocation history",
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
const documentGroup = computed<ConsoleCommandGroup>(() => ({
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

// Reads like a row of the session list: `Done`, then `5m ago` within a day or a date such as `Aug 30`.
function itemDescription(item: ConsoleSearchItem): string {
  const age = recentTimestamp(item.updatedAt, Date.now());
  return [item.agentName, invocationStatusLabel(item.status), age === "now" ? "just now" : age, item.excerpt ? undefined : item.context]
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
      || ["definition-catalog", "workspace-browser"].includes(installedNavigation.value?.contributions[section]?.view.kind ?? "")
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
    discoveredHistoricalAgentNames.value = []
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
      const catalog = resolveConsoleAgentCatalog(agentsValue)
      if (navigationRequest !== controller) return;
      discoveredAgentNames.value = catalog.agents;
      discoveredHistoricalAgentNames.value = catalog.historicalAgents;
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
}, { immediate: true });

// The palette filters with the ranking of the Nuxt UI palette it replaced: 100 ms after typing stops, at most 12 matches.
const filterTerm = ref(searchTerm.value)
let filterTimer: ReturnType<typeof setTimeout> | undefined
watch(searchTerm, (value) => {
  if (filterTimer) clearTimeout(filterTimer)
  filterTimer = setTimeout(() => {
    filterTimer = undefined
    filterTerm.value = value
  }, 100)
})

const command = createCommandController()
// The stack of nested pages, by the value of the command that opened each one. Closing search drops it.
const pages = ref<string[]>([])
// An element inside the dialog: the ⌘K shortcut that closes search belongs to the dialog through it.
const inputRow = useTemplateRef<HTMLElement>("inputRow")

/** Gives each command a value that stays the same while the query filters it, and finds a command by its value. */
const commandValues = computed(() => {
  const values = new Map<ConsoleCommand, string>()
  const commands = new Map<string, ConsoleCommand>()
  const add = (item: ConsoleCommand, value: string) => {
    values.set(item, value)
    commands.set(value, item)
    item.children?.forEach((child, index) => add(child, `${value}/${index}`))
  }
  for (const group of groups.value) group.items.forEach((item, index) => add(item, `${group.id}:${index}`))
  return { commands, values }
})
const valueOf = (item: ConsoleCommand) => commandValues.value.values.get(item) ?? item.label
const currentPage = computed(() => {
  const value = pages.value.at(-1)
  return value === undefined ? undefined : commandValues.value.commands.get(value)
})
const shownGroups = computed<ConsoleCommandGroup[]>(() => {
  const page = currentPage.value
  const source = page ? [{ id: valueOf(page), items: page.children ?? [], label: page.label }] : groups.value
  return filterConsoleCommandGroups(source, filterTerm.value, { keywords: true, preserveGroupOrder: true, tokens: true })
})
const shownCommands = computed(() => shownGroups.value.flatMap(group => group.items))
const placeholder = computed(() => currentPage.value?.placeholder ?? "Search the Console…")

// New results highlight their first command, as the palette did before, so Enter runs the best match.
watch(shownGroups, () => {
  void nextTick(() => {
    const first = shownCommands.value.find(item => !item.disabled)
    if (first) command.setValue(valueOf(first))
  })
})

/** Runs a command with the click or key press, so ⌘-click opens a page in a new tab, then closes search. */
function runCommand(value: string, details: CommandActionDetails): void {
  const item = commandValues.value.commands.get(value)
  if (!item || item.disabled || item.children?.length) return
  item.onSelect?.(details.event)
  open.value = false
  searchTerm.value = ""
}

// Escape closes search at once, with or without a query, as before. Leaving a page clears the query and does not
// bring back the one typed on the page before.
function onQueryChange(_query: string, details: { reason: CommandQueryChangeReason, cancel: () => void }): void {
  if (details.reason === "escape-key") {
    details.cancel()
    open.value = false
  }
  else if (details.reason === "back") details.cancel()
}

function onPagesChange(_pages: string[], details: { reason: CommandPagesChangeReason, cancel: () => void }): void {
  if (details.reason !== "escape-key") return
  details.cancel()
  open.value = false
}

function back(): void {
  command.pop()
  command.setQuery("")
  command.focus()
}

// Home and End move the highlight to the first and the last command, as in the palette before.
function onInputKeydown(event: KeyboardEvent): void {
  if ((event.key !== "Home" && event.key !== "End") || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
  const enabled = shownCommands.value.filter(item => !item.disabled)
  const target = event.key === "Home" ? enabled[0] : enabled.at(-1)
  if (!target) return
  event.preventDefault()
  command.setValue(valueOf(target))
}

// The page shortcut of console-search.vue opens search. While search is open, ⌘K or Ctrl K closes it.
useShortcut("mod+k", () => { open.value = false }, () => ({ allowInInput: true, layer: inputRow.value }))

// Focus goes back to where it was when search opened, such as the Search row.
let returnFocus: Element | null = null
watch(open, (value) => {
  if (value) returnFocus = "document" in globalThis ? document.activeElement : null
  else pages.value = []
}, { flush: "sync", immediate: true })
const finalFocus = () => (returnFocus instanceof HTMLElement && returnFocus.isConnected ? returnFocus : undefined)

/**
 * The command list runs Enter without its modifiers, so ⌘ Enter and Ctrl Enter click the highlighted command with that
 * modifier. The command then opens its page in a new tab.
 */
function openHighlightedInNewTab(event: KeyboardEvent): void {
  if (!open.value || event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.isComposing) return
  const highlighted = inputRow.value?.closest('[data-slot="command"]')?.querySelector('[role="option"][data-highlighted]')
  if (!(highlighted instanceof HTMLElement)) return
  event.preventDefault()
  event.stopPropagation()
  highlighted.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: event.ctrlKey, metaKey: event.metaKey }))
}

// The keys of the rows and the footer, drawn like Nuxt UI's Kbd in the palette before.
const kbdClass = "inline-flex items-center justify-center rounded-sm border-0 bg-default px-1 py-0 font-sans text-xs font-medium text-default uppercase ring ring-inset ring-accented"
const footerKbdClass = [kbdClass, "h-4 min-w-[16px]"]
const { text: modKey } = useShortcutHint("mod")

// Server rendering and component tests mount search without a window.
const browserWindow = (): Window | undefined => ("window" in globalThis ? window : undefined)

onMounted(() => {
  browserWindow()?.addEventListener("keydown", openHighlightedInNewTab, true)
});

onBeforeUnmount(() => {
  browserWindow()?.removeEventListener("keydown", openHighlightedInNewTab, true);
  navigationRequest?.abort();
  sessionRequest?.abort();
  documentRequest?.abort();
  if (searchTimer) clearTimeout(searchTimer);
  if (filterTimer) clearTimeout(filterTimer);
});
</script>

<template>
  <!-- A ui-sdk scope root. The dialog renders here, in the top layer, so the kit styles reach it. -->
  <div class="ui-sdk contents">
    <Dialog v-model:open="open">
      <DialogBackdrop class="fixed inset-0 bg-black/40 transition-opacity duration-200 ease-out data-starting-style:opacity-0 data-ending-style:opacity-0 dark:bg-black/60" />
      <DialogContent
        :final-focus="finalFocus"
        initial-focus="input"
        class="fixed top-1/2 left-1/2 m-0 flex h-full max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-0 overflow-hidden rounded-xl border-0 bg-default p-0 text-sm/6 text-default shadow-(--vh-shadow-dialog) transition-[opacity,scale] duration-200 ease-out focus:outline-none data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 sm:h-[28rem] sm:max-h-[calc(100dvh-4rem)] sm:max-w-3xl"
      >
        <DialogTitle class="sr-only">Search console</DialogTitle>
        <DialogDescription class="sr-only">Run actions and search pages, documents, Agents, definitions, KV keys, and sessions.</DialogDescription>
        <Command
          v-model:query="searchTerm"
          v-model:pages="pages"
          :controller="command"
          :filter="false"
          :loop="false"
          class="flex min-h-0 w-auto max-w-none flex-1 flex-col divide-y divide-default rounded-none border-0 bg-transparent text-sm"
          :on-action="runCommand"
          @query-change="onQueryChange"
          @pages-change="onPagesChange"
        >
          <div ref="inputRow" class="relative m-0 inline-flex items-center p-0">
            <span class="absolute inset-y-0 start-0 flex items-center ps-2.5">
              <button v-if="pages.length" type="button" aria-label="Back" class="inline-flex items-center rounded-md p-0 text-xs text-muted outline-inverted/25 hover:text-default focus-visible:outline-3" @click="back">
                <Icon name="i-lucide-arrow-left" class="size-4 shrink-0 opacity-80" />
              </button>
              <Icon v-else-if="loading" name="i-lucide-loader-circle" class="size-4 shrink-0 animate-spin text-dimmed opacity-80" />
              <Icon v-else name="i-lucide-search" class="size-4 shrink-0 text-dimmed opacity-80" />
            </span>
            <CommandInput
              aria-label="Search the Console"
              :placeholder="placeholder"
              autocomplete="off"
              class="h-12 w-full appearance-none rounded-md border-0 bg-transparent px-2.5 py-1.5 ps-8 pe-8 text-sm/4 text-highlighted placeholder:text-dimmed focus:outline-none pointer-coarse:text-base"
              @keydown="onInputKeydown"
            />
            <span class="absolute inset-y-0 end-0 flex items-center pe-2.5">
              <DialogClose aria-label="Close" class="inline-flex h-auto items-center gap-1.5 rounded-md border-0 bg-transparent p-1.5 text-xs font-medium text-default outline-inverted/25 transition-[color,background-color,box-shadow,transform] duration-150 ease-out hover:bg-elevated focus-visible:outline-3 active:bg-elevated motion-safe:active:scale-[.97] motion-reduce:transition-none">
                <Icon name="i-lucide-x" class="size-4 shrink-0 opacity-80" />
              </DialogClose>
            </span>
          </div>
          <div class="relative flex flex-1 flex-col overflow-hidden">
            <CommandList v-show="shownGroups.length" aria-label="Results" class="relative max-h-none flex-1 scroll-py-1 divide-y divide-default overflow-y-auto p-0 focus:outline-none">
              <CommandPage :key="pages.at(-1) ?? ''" :value="pages.at(-1)">
                <CommandGroup v-for="group in shownGroups" :key="group.id" class="isolate p-1">
                  <CommandGroupLabel class="p-1.5 text-xs font-semibold text-highlighted">{{ group.label }}</CommandGroupLabel>
                  <CommandItem
                    v-for="item in group.items"
                    :key="valueOf(item)"
                    :value="valueOf(item)"
                    :label="item.label"
                    :disabled="item.disabled"
                    :page="item.children?.length ? valueOf(item) : undefined"
                    class="group relative isolate flex min-h-0 w-full items-start gap-1.5 rounded-none bg-transparent p-1.5 text-sm outline-none select-none before:absolute before:inset-px before:z-[-1] before:rounded-md data-disabled:cursor-not-allowed data-disabled:opacity-75 data-highlighted:bg-transparent"
                    :class="item.active ? 'text-highlighted before:bg-elevated' : 'text-default transition-colors before:transition-colors data-highlighted:not-data-disabled:text-highlighted data-highlighted:not-data-disabled:before:bg-elevated/50'"
                  >
                    <!-- Documents lead with their state dot, as in the Content list. The label next to it is for screen readers. -->
                    <span v-if="item.kind === 'document'" class="flex size-5 shrink-0 items-center justify-center">
                      <Status :tone="consoleDocumentStateColor(item.state ?? 'draft')" />
                      <span v-if="item.stateLabel" class="sr-only">{{ item.stateLabel }}</span>
                    </span>
                    <Icon v-else-if="item.loading" name="i-lucide-loader-circle" class="size-4 shrink-0 animate-spin text-dimmed" />
                    <!-- Section commands show the same section icon as the rail and the Overview. -->
                    <ConsoleSectionIcon v-else-if="item.kind === 'section' && item.icon" :icon="item.icon" class="size-4 shrink-0" />
                    <Icon v-else-if="item.icon" :name="item.icon" class="size-4 shrink-0 transition-colors" :class="item.active ? 'text-default' : 'text-dimmed group-data-highlighted:not-group-data-disabled:text-default'" />
                    <span class="flex min-w-0 flex-1 flex-col text-start">
                      <span class="truncate space-x-1 text-dimmed">
                        <span class="text-highlighted">{{ item.label }}</span>
                        <span v-if="item.suffix" class="text-dimmed">{{ item.suffix }}</span>
                      </span>
                      <span v-if="item.description" class="truncate text-muted">{{ item.description }}</span>
                    </span>
                    <span class="ms-auto inline-flex items-center gap-1.5">
                      <Icon v-if="item.children?.length" name="i-lucide-chevron-right" class="size-5 shrink-0" />
                      <span v-else-if="item.kbds?.length" class="hidden shrink-0 items-center gap-0.5 lg:inline-flex">
                        <kbd v-for="key in item.kbds" :key="key" :class="[kbdClass, 'h-5 min-w-[20px]']">{{ key }}</kbd>
                      </span>
                    </span>
                  </CommandItem>
                </CommandGroup>
              </CommandPage>
            </CommandList>
            <div v-if="!shownGroups.length" data-slot="vh-empty" data-size="sm" role="status" class="py-10">
              <span data-slot="vh-empty-icon"><Icon name="i-lucide-search-x" aria-hidden="true" /></span>
              <h2 data-slot="vh-empty-title">No matches</h2>
              <p data-slot="vh-empty-description">{{ searchTerm.trim() ? "Try a page, document, Agent, definition, key, or session." : "No Console results are available yet." }}</p>
            </div>
          </div>
          <div class="vitehub-console__search-footer px-3 py-2">
            <span><kbd :class="footerKbdClass">↑</kbd><kbd :class="footerKbdClass">↓</kbd> Navigate</span>
            <span><kbd :class="footerKbdClass">↵</kbd> Select</span>
            <span><kbd :class="footerKbdClass">{{ modKey }}</kbd><kbd :class="footerKbdClass">↵</kbd> New tab</span>
            <span><kbd :class="footerKbdClass">⌫</kbd> Back</span>
            <span><kbd :class="footerKbdClass">Esc</kbd> Close</span>
            <span class="vitehub-console__search-footer-end"><kbd :class="footerKbdClass">g</kbd> then a key to go to a page</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  </div>
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
