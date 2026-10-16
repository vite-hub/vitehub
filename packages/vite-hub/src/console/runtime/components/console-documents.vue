<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { consoleErrorMessage, consoleListQueryFor, createConsoleDocumentsClient } from "../client/documents";
import { requestConsole } from "../client/request";
import { parseConsoleSectionContent } from "../definitions";
import { rememberConsoleSection } from "../sections";
import ConsoleDocumentEditor from "./console-document-editor.vue";
import ConsoleDocumentList from "./console-document-list.vue";
import ConsoleFrame from "./console-frame.vue";
import ConsoleSearch from "./console-search.vue";

import type { ConsoleContributedSection, ConsoleDocumentCollection } from "../definitions";

/**
 * Document editor section: collections in the sidebar, the documents of the selected collection, and the editor of one
 * document. The route is `/<section>/<collection>/<document id>`; `?new` opens an empty document.
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
// Bumps after a save, publish, or delete so the list reloads.
const changes = ref(0);

function param(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.length ? value.join("/") : undefined;
  return String(value) === value && value ? value : undefined;
}

const collectionName = computed(() => param(route.params.collection));
const documentId = computed(() => param(route.params.document));
const creating = computed(() => route.query.new !== undefined && !documentId.value);
const collection = computed(() => collections.value.find(entry => entry.name === collectionName.value));

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
    if (!collectionName.value && collections.value[0]) {
      await router.replace({ params: { ...route.params, collection: collections.value[0].name, document: [] }, query: {} });
    }
  }
  catch (requestError) {
    error.value = requestError;
  }
  finally {
    loading.value = false;
  }
}

function collectionRoute(name: string) {
  return { name: route.name ?? undefined, params: { collection: name, document: [] }, query: consoleListQueryFor(name) };
}

onMounted(() => {
  rememberConsoleSection(section.value);
  void loadCollections();
});

watch(section, () => {
  rememberConsoleSection(section.value);
  collections.value = [];
  void loadCollections();
});
</script>

<template>
  <ConsoleFrame :active="section" :sections-base="sectionsBase">
    <UDashboardSidebar
      id="console-navigation"
      v-model:open="sidebarOpen"
      class="vitehub-console__nav"
      :default-size="15"
      :collapsed-size="4"
      :min-size="12"
      :max-size="24"
      :menu="{ title: details.label, description: details.description }"
      :ui="{ body: 'gap-0 overflow-hidden p-0' }"
      resizable
    >
      <template #header="{ collapsed }">
        <div v-if="!collapsed" class="vitehub-console__panel-title">
          <span class="min-w-0 flex-1 truncate">{{ details.label }}</span>
          <UTooltip text="Reload collections">
            <UButton aria-label="Reload collections" icon="i-lucide-refresh-cw" size="xs" variant="ghost" :loading="loading" @click="loadCollections" />
          </UTooltip>
        </div>
      </template>

      <template #default="{ collapsed }">
        <div v-if="!collapsed && error" class="px-3">
          <UAlert
            color="error"
            variant="subtle"
            icon="i-lucide-cloud-off"
            title="Couldn't load collections"
            :description="consoleErrorMessage(error)"
            :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', color: 'neutral', variant: 'outline', onClick: loadCollections }]"
          />
        </div>
        <div v-else-if="loading && !collections.length" class="grid gap-2 px-3">
          <USkeleton v-for="index in 3" :key="index" class="h-8 rounded-md" />
        </div>
        <nav v-else-if="collections.length" class="grid gap-0.5 px-2 pb-3" aria-label="Collections">
          <UButton
            v-for="entry in collections"
            :key="entry.name"
            :to="collectionRoute(entry.name)"
            block
            class="justify-start"
            color="neutral"
            :variant="entry.name === collectionName ? 'soft' : 'ghost'"
            :aria-current="entry.name === collectionName ? 'page' : undefined"
            :icon="collapsed ? details.icon : undefined"
            :label="collapsed ? undefined : entry.label"
            @click="sidebarOpen = false"
          >
            <template v-if="!collapsed" #trailing>
              <UBadge v-if="!entry.access.write" class="ms-auto" color="neutral" variant="outline" size="sm" label="Read-only" />
            </template>
          </UButton>
        </nav>
        <UEmpty
          v-else-if="!collapsed"
          class="min-h-0 flex-1 px-4"
          :icon="details.icon"
          title="No collections"
          description="Define document collections in server/content.ts, or ask for access to one."
        />
      </template>
    </UDashboardSidebar>

    <ConsoleSearch
      :agents-base="agentsBase"
      :definitions-base="definitionsBase"
      :kv-base="kvBase"
      :search-base="searchBase"
      :sections-base="sectionsBase"
    />

    <UDashboardPanel :id="`${section}-documents`" :ui="{ body: 'min-h-0 overflow-hidden p-0 gap-0' }">
      <template v-if="collection && (documentId || creating)">
        <ConsoleDocumentEditor
          :key="`${collection.name}/${documentId ?? '~new'}`"
          :client="client"
          :collection="collection"
          :document-id="documentId"
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
