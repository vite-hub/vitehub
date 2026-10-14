<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";

import {
  compactConsoleFieldValues,
  consoleDocumentSlug,
  consoleDocumentStateColor,
  consoleDocumentStateLabel,
  consoleErrorMessage,
  consoleFieldIssues,
  consoleListQueryFor,
  consolePublishMismatches,
  consoleSchemaDefaults,
  consoleSingularLabel,
  describeConsoleSchemaFields,
  groupConsoleFieldIssues,
  groupConsoleRevisions,
  humanizeConsoleFieldIssues,
  isConsoleConflict,
  isConsoleDocumentId,
  stableConsoleJSON,
} from "../client/documents";
import { useConsoleToast } from "../client/toast";
import ConsoleDocumentDiff from "./console-document-diff.vue";
import ConsoleMarkdownEditor from "./console-markdown-editor.vue";
import ConsoleRelativeTime from "./console-relative-time.vue";
import ConsoleSchemaForm from "./console-schema-form.vue";
import ConsoleStatus from "./console-status.vue";

import type { ConsoleDocument, ConsoleDocumentCollection, ConsoleDocumentRevision, ConsoleDocumentsClient, ConsoleDocumentState, ConsoleRawDocument } from "../client/documents";

/**
 * Edits one document. Every save sends the digest of the version the editor read, so a save never overwrites a newer
 * version: a conflict opens a comparison instead. Invalid fields come back from the owner validators and show inline.
 */
const props = defineProps<{
  changes: number;
  client: ConsoleDocumentsClient;
  collection: ConsoleDocumentCollection;
  /** Undefined for a new document. */
  documentId?: string;
}>();

const emit = defineEmits<{ changed: [] }>();

interface Version {
  body: string;
  data: Record<string, unknown>;
}

const route = useRoute();
const router = useRouter();
const toast = useConsoleToast();
const creating = computed(() => props.documentId === undefined);
const fields = computed(() => describeConsoleSchemaFields(props.collection.schema));
const noun = computed(() => consoleSingularLabel(props.collection.label));
const titleField = computed(() => fields.value.find(field => field.name === props.collection.titleField && field.kind === "string"));
// The title gets the large input above the body. The sidebar form shows every other field.
const sidebarSchema = computed(() => {
  const source = props.collection.schema.properties;
  const properties: Record<string, unknown> = source instanceof Object && !Array.isArray(source) ? Object.fromEntries(Object.entries(source)) : {};
  if (titleField.value) delete properties[titleField.value.name];
  return { ...props.collection.schema, properties };
});

const loading = ref(!creating.value);
const loadError = ref<unknown>();
/** The version the editor read: the last loaded or saved document. Null for a new or deleted document. */
const base = ref<ConsoleDocument | null>(null);
const state = ref<ConsoleDocumentState | undefined>();
const draft = ref<Version>({ body: "", data: creating.value ? consoleSchemaDefaults(props.collection.schema) : {} });
const newId = ref("");
const idEdited = ref(false);
const saving = ref(false);
const publishing = ref(false);
/** When this editor last saved, for `Saved 2m ago`. */
const savedAt = ref<string>();
/** Why the last save failed, when the failure is not a field issue or a conflict. */
const saveError = ref<string>();
const fieldErrors = ref<Record<string, string[]>>({});
const conflict = ref<{ mine: Version, theirs: ConsoleDocument | null }>();
const deleteOpen = ref(false);
const deleting = ref(false);
const historyOpen = ref(false);
const revisions = ref<ConsoleDocumentRevision[]>([]);
const revisionsCursor = ref<string>();
const revisionsLoading = ref(false);
const revisionsError = ref<unknown>();
const revisionsLoadedAt = ref(Date.now());
/** A revision as stored, next to the saved draft. Stored files show even when they no longer validate. */
const preview = ref<{ current: ConsoleRawDocument | null, document: ConsoleRawDocument | null, revision: ConsoleDocumentRevision }>();
const previewLoading = ref(false);
const restoring = ref(false);
const bodyEditor = ref<{ commit: () => Promise<void> }>();
let mounted = true;

const canWrite = computed(() => props.collection.access.write);
const canPublish = computed(() => props.collection.access.publish);
const id = computed(() => (creating.value ? newId.value.trim() : props.documentId!));
const savedVersion = computed<Version>(() => (base.value ? { body: base.value.body, data: base.value.data } : { body: "", data: consoleSchemaDefaults(props.collection.schema) }));
const dirty = computed(() => {
  if (creating.value) return Boolean(newId.value.trim()) || stableConsoleJSON(compact(draft.value.data)) !== stableConsoleJSON(compact(savedVersion.value.data)) || Boolean(draft.value.body.trim());
  if (!base.value) return false;
  // The editor writes canonical Markdown, which can drop a trailing newline that the stored file has.
  return draft.value.body.trimEnd() !== base.value.body.trimEnd() || stableConsoleJSON(compact(draft.value.data)) !== stableConsoleJSON(compact(base.value.data));
});
const deleted = computed(() => !creating.value && !loading.value && !base.value && state.value === "deleted");
const missing = computed(() => !creating.value && !loading.value && !base.value && !loadError.value && state.value !== "deleted");
const publishable = computed(() => canPublish.value && !creating.value && (state.value === "draft" || state.value === "changed" || state.value === "deleted"));
const title = computed(() => {
  const value = titleField.value ? draft.value.data[titleField.value.name] : undefined;
  return String(value) === value && value.trim() ? value : creating.value ? `New ${noun.value.toLowerCase()}` : props.documentId!;
});
const errorCount = computed(() => Object.values(fieldErrors.value).reduce((count, messages) => count + messages.length, 0));
const idError = computed(() => (creating.value && newId.value && !isConsoleDocumentId(newId.value.trim()) ? "Id can use letters, numbers, dashes, and slashes, such as hello-world or 2026/launch." : fieldErrors.value[""]?.join(" ")));
const revisionGroups = computed(() => groupConsoleRevisions(revisions.value, revisionsLoadedAt.value));

// "Saving…" shows only when a save takes longer than 200ms, then stays at least 400ms, so fast saves do not flicker.
const savingVisible = ref(false);
let savingShowTimer: ReturnType<typeof setTimeout> | undefined;
let savingHideTimer: ReturnType<typeof setTimeout> | undefined;
let savingShownAt = 0;
watch(saving, (value) => {
  clearTimeout(savingShowTimer);
  clearTimeout(savingHideTimer);
  if (value) {
    savingShowTimer = setTimeout(() => {
      savingVisible.value = true;
      savingShownAt = Date.now();
    }, 200);
    return;
  }
  if (savingVisible.value) savingHideTimer = setTimeout(() => (savingVisible.value = false), Math.max(0, 400 - (Date.now() - savingShownAt)));
});

/** One status for the header: local edits first, then the document state with the last save time. */
const headerStatus = computed<{ label: string, pending?: boolean, savedAt?: string, tone: "error" | "neutral" | "success" | "warning" } | undefined>(() => {
  if (savingVisible.value) return { label: "Saving…", pending: true, tone: "neutral" };
  if (errorCount.value) return { label: `${errorCount.value === 1 ? "1 field needs" : `${errorCount.value} fields need`} attention`, tone: "error" };
  if (saveError.value && dirty.value) return { label: "Not saved", tone: "error" };
  if (dirty.value) return { label: "Unsaved", tone: "warning" };
  if (!state.value) return undefined;
  return { label: consoleDocumentStateLabel(state.value), savedAt: savedAt.value, tone: consoleDocumentStateColor(state.value) };
});

function compact(data: Record<string, unknown>): Record<string, unknown> {
  return compactConsoleFieldValues(fields.value, data);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function listRoute() {
  return { name: route.name ?? undefined, params: { collection: props.collection.name, document: [] }, query: consoleListQueryFor(props.collection.name) };
}

function documentRoute(documentId: string) {
  return { name: route.name ?? undefined, params: { collection: props.collection.name, document: documentId.split("/") }, query: {} };
}

function accept(document: ConsoleDocument): void {
  base.value = document;
  state.value = document.state;
  draft.value = { body: document.body, data: clone(document.data) };
}

async function load(): Promise<void> {
  if (creating.value) return;
  loading.value = true;
  try {
    const document = await props.client.get(props.collection.name, props.documentId!);
    if (document) accept(document);
    else {
      base.value = null;
      // A document removed from the draft is still listed as deleted while it stays published.
      const listed = await props.client.list(props.collection.name, { filter: { id: props.documentId! }, limit: 1, state: "deleted" });
      state.value = listed.items[0]?.state;
    }
    loadError.value = undefined;
  }
  catch (error) {
    loadError.value = error;
  }
  finally {
    loading.value = false;
  }
}

/** Focuses the first invalid field, in page order. */
async function focusFirstInvalid(): Promise<void> {
  await nextTick();
  const target = document.querySelector<HTMLElement>(".vitehub-document-editor [aria-invalid='true']");
  target?.focus({ preventScroll: true });
  target?.scrollIntoView({ block: "center", behavior: "instant" });
}

// Each field keeps its server issue until someone changes that field.
let errorSnapshot: Record<string, string> = {};
watch(() => draft.value.data, (data) => {
  if (!errorCount.value) return;
  const next = Object.fromEntries(Object.entries(fieldErrors.value).filter(([path]) => {
    const name = path.split(".")[0] ?? "";
    return !name || stableConsoleJSON(data[name] ?? null) === errorSnapshot[name];
  }));
  if (Object.keys(next).length !== Object.keys(fieldErrors.value).length) fieldErrors.value = next;
}, { deep: true });

async function save(options: { ifDigest?: string | null } = {}): Promise<void> {
  if (!canWrite.value || saving.value) return;
  await bodyEditor.value?.commit();
  if (creating.value && !isConsoleDocumentId(id.value)) {
    fieldErrors.value = { "": [id.value ? "Id can use letters, numbers, dashes, and slashes." : "Id is required."] };
    errorSnapshot = {};
    await focusFirstInvalid();
    return;
  }
  saving.value = true;
  saveError.value = undefined;
  const sent: Version = { body: draft.value.body, data: compact(draft.value.data) };
  try {
    const saved = await props.client.save(props.collection.name, id.value, {
      ...sent,
      ifDigest: options.ifDigest !== undefined ? options.ifDigest : base.value?.digest ?? null,
    });
    fieldErrors.value = {};
    conflict.value = undefined;
    // Keep edits made while the save was running.
    const editedDuringSave = draft.value.body !== sent.body || stableConsoleJSON(compact(draft.value.data)) !== stableConsoleJSON(sent.data);
    base.value = saved;
    state.value = saved.state;
    if (!editedDuringSave) draft.value = { body: saved.body === sent.body ? draft.value.body : saved.body, data: clone(saved.data) };
    savedAt.value = new Date().toISOString();
    emit("changed");
    // The saved document opens at its own route. The history state tells the new editor when it saved.
    if (creating.value) await router.replace({ ...documentRoute(saved.id), state: { vitehubDocumentSavedAt: savedAt.value } });
    if (historyOpen.value) void loadRevisions();
  }
  catch (error) {
    const issues = consoleFieldIssues(error);
    if (issues) {
      fieldErrors.value = groupConsoleFieldIssues(humanizeConsoleFieldIssues(fields.value, issues));
      errorSnapshot = Object.fromEntries(Object.entries(draft.value.data).map(([name, value]) => [name, stableConsoleJSON(value ?? null)]));
      await focusFirstInvalid();
    }
    else if (isConsoleConflict(error)) {
      const theirs = await props.client.get(props.collection.name, id.value).catch(() => null);
      conflict.value = { mine: sent, theirs };
    }
    else {
      saveError.value = consoleErrorMessage(error, "The request failed.");
      toast.error("Couldn't save. Try again.", { label: "Retry", onClick: () => save() });
    }
  }
  finally {
    saving.value = false;
  }
}

function keepMine(): void {
  if (!conflict.value) return;
  const theirs = conflict.value.theirs;
  // Overwrite only the version just compared. Another save in the meantime conflicts again.
  void save({ ifDigest: theirs?.digest ?? null });
}

function useTheirs(): void {
  if (!conflict.value) return;
  const theirs = conflict.value.theirs;
  conflict.value = undefined;
  if (theirs) accept(theirs);
  else void load();
}

// Publishing flips the state at once and rolls back if the request fails.
async function publish(): Promise<void> {
  if (!canPublish.value || dirty.value || publishing.value) return;
  const before = state.value;
  const removing = deleted.value;
  publishing.value = true;
  if (!removing) state.value = "published";
  try {
    // Publish exactly the draft on screen. A deleted document has no draft to expect.
    const result = await props.client.publish(props.collection.name, [{ digest: base.value?.digest ?? null, id: id.value }]);
    if (result.documents.length) toast.show({ title: removing ? `${noun.value} removed from the site` : "Changes published" });
    emit("changed");
    if (removing) await router.replace(listRoute());
    else await load();
  }
  catch (error) {
    state.value = before;
    const issues = consoleFieldIssues(error);
    if (consolePublishMismatches(error)) {
      // Someone saved after this editor loaded. Show their draft so it is reviewed before it is published.
      await load();
      toast.error("Someone saved a newer draft. Review it, then publish again.");
    }
    else if (issues) {
      fieldErrors.value = groupConsoleFieldIssues(humanizeConsoleFieldIssues(fields.value, issues));
      errorSnapshot = Object.fromEntries(Object.entries(draft.value.data).map(([name, value]) => [name, stableConsoleJSON(value ?? null)]));
      toast.error("This draft no longer validates. Fix it, then save and publish.");
      await focusFirstInvalid();
    }
    else toast.error("Couldn't publish. Try again.", { label: "Retry", onClick: publish });
  }
  finally {
    publishing.value = false;
  }
}

async function remove(): Promise<void> {
  if (!base.value) return;
  const removed = { id: id.value, revision: base.value.revision };
  const { client, collection } = props;
  deleting.value = true;
  try {
    await client.remove(collection.name, removed.id, base.value.digest);
    deleteOpen.value = false;
    base.value = null;
    emit("changed");
    await router.replace(listRoute());
    // Undo puts the saved version back and opens it again.
    toast.show({
      action: {
        label: "Undo",
        onClick: async () => {
          try {
            await client.restore(collection.name, removed.id, removed.revision, null);
            await router.push(documentRoute(removed.id));
          }
          catch {
            toast.error(`Couldn't restore the ${noun.value.toLowerCase()}. Try again from History.`);
          }
        },
      },
      title: `${noun.value} deleted`,
    });
  }
  catch (error) {
    deleteOpen.value = false;
    toast.error(isConsoleConflict(error) ? `This ${noun.value.toLowerCase()} changed since you opened it. Reload, then delete it.` : "Couldn't delete. Try again.");
  }
  finally {
    deleting.value = false;
  }
}

async function loadRevisions(more = false): Promise<void> {
  if (creating.value) return;
  revisionsLoading.value = true;
  try {
    const result = await props.client.revisions(props.collection.name, id.value, more ? revisionsCursor.value : undefined);
    revisions.value = more ? [...revisions.value, ...result.revisions] : result.revisions;
    revisionsCursor.value = result.cursor;
    revisionsLoadedAt.value = Date.now();
    revisionsError.value = undefined;
  }
  catch (error) {
    revisionsError.value = error;
  }
  finally {
    revisionsLoading.value = false;
  }
}

async function openRevision(revision: ConsoleDocumentRevision): Promise<void> {
  previewLoading.value = true;
  preview.value = { current: null, document: null, revision };
  try {
    const [document, current] = await Promise.all([
      props.client.raw(props.collection.name, id.value, revision.id),
      props.client.raw(props.collection.name, id.value),
    ]);
    preview.value = { current, document, revision };
  }
  catch {
    toast.error("Couldn't open this version. Try again.");
    preview.value = undefined;
  }
  finally {
    previewLoading.value = false;
  }
}

/**
 * Restores the previewed version without asking first: the toast offers Undo, which puts back the saved version and
 * any unsaved edits from before the restore.
 */
async function restore(): Promise<void> {
  if (!preview.value?.document) return;
  await bodyEditor.value?.commit();
  const before = { document: base.value, unsaved: dirty.value ? clone(draft.value) : undefined };
  const { client, collection } = props;
  const documentId = id.value;
  restoring.value = true;
  try {
    const restored = await client.restore(collection.name, documentId, preview.value.revision.id, base.value?.digest ?? null);
    accept(restored);
    savedAt.value = new Date().toISOString();
    fieldErrors.value = {};
    preview.value = undefined;
    historyOpen.value = false;
    emit("changed");
    toast.show({
      action: {
        label: "Undo",
        onClick: async () => {
          try {
            const current = mounted ? base.value?.digest ?? restored.digest : restored.digest;
            if (before.document) {
              const reverted = await client.restore(collection.name, documentId, before.document.revision, current);
              if (mounted) accept(reverted);
            }
            else {
              await client.remove(collection.name, documentId, current);
              if (mounted) {
                base.value = null;
                state.value = "deleted";
              }
            }
            if (mounted && before.unsaved) draft.value = before.unsaved;
            emit("changed");
          }
          catch {
            toast.error("Couldn't undo the restore. Pick the earlier version in History.");
          }
        },
      },
      title: "Version restored",
    });
  }
  catch (error) {
    toast.error(isConsoleConflict(error) ? `This ${noun.value.toLowerCase()} changed since you opened it. Reload, then restore.` : "Couldn't restore. Try again.");
  }
  finally {
    restoring.value = false;
  }
}

function revisionLabel(revision: ConsoleDocumentRevision): string {
  if (revision.ref === "published" || revision.action === "publish") return "Published";
  return { remove: "Deleted", restore: "Restored", save: "Saved", seed: "Started draft" }[revision.action] ?? "Changed";
}

function revisionTone(revision: ConsoleDocumentRevision): "error" | "neutral" | "success" {
  if (revision.ref === "published" || revision.action === "publish") return "success";
  return revision.action === "remove" ? "error" : "neutral";
}

function initials(name: string): string {
  return name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join("") || "?";
}

// Write pending body edits first, so a shortcut pressed right after typing still saves them.
async function saveFromShortcut(): Promise<void> {
  await bodyEditor.value?.commit();
  if (dirty.value) await save();
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void saveFromShortcut();
  }
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!dirty.value) return;
  event.preventDefault();
}

// The id follows the title until someone edits the id.
watch(() => (titleField.value ? draft.value.data[titleField.value.name] : undefined), (value) => {
  if (creating.value && !idEdited.value) newId.value = consoleDocumentSlug(String(value ?? ""));
});
watch(historyOpen, (open) => {
  if (open) void loadRevisions();
  if (!open) preview.value = undefined;
});
watch(() => props.changes, () => {
  if (!dirty.value && !creating.value && !saving.value && !publishing.value) void load();
});

onBeforeRouteLeave(() => {
  if (dirty.value && !saving.value && !window.confirm("Leave without saving? Your changes will be lost.")) return false;
});
onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("beforeunload", onBeforeUnload);
  const saved: unknown = window.history.state?.vitehubDocumentSavedAt;
  if (String(saved) === saved) savedAt.value = saved;
  void load();
});
onBeforeUnmount(() => {
  mounted = false;
  clearTimeout(savingShowTimer);
  clearTimeout(savingHideTimer);
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("beforeunload", onBeforeUnload);
});

const menuItems = computed(() => [[
  ...(!creating.value ? [{ label: "History", icon: "i-lucide-history", onSelect: () => (historyOpen.value = true) }] : []),
  { label: "Copy id", icon: "i-lucide-copy", onSelect: () => void navigator.clipboard?.writeText(id.value) },
], ...(canWrite.value && base.value ? [[{ label: "Delete", icon: "i-lucide-trash-2", color: "error" as const, onSelect: () => (deleteOpen.value = true) }]] : [])]);
</script>

<template>
  <UDashboardNavbar :ui="{ root: 'border-b border-default', right: 'gap-2' }" :toggle="{ 'aria-label': 'Open collections' }">
    <template #leading>
      <UButton :to="listRoute()" variant="ghost" size="sm" icon="i-lucide-arrow-left" :aria-label="`Back to ${collection.label}`" />
    </template>
    <template #title>
      <span class="flex min-w-0 items-center gap-2">
        <RouterLink :to="listRoute()" class="hidden shrink-0 text-sm font-normal text-muted hover:text-highlighted sm:inline">{{ collection.label }}</RouterLink>
        <span class="hidden text-dimmed sm:inline" aria-hidden="true">/</span>
        <span class="truncate text-sm font-medium text-highlighted">{{ title }}</span>
      </span>
    </template>
    <template #right>
      <span class="hidden sm:inline-flex" role="status" aria-live="polite">
        <button
          v-if="headerStatus && errorCount && !savingVisible"
          type="button"
          class="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2"
          @click="focusFirstInvalid"
        >
          <ConsoleStatus :label="headerStatus.label" :tone="headerStatus.tone" class="underline decoration-dotted underline-offset-4 hover:text-highlighted" />
        </button>
        <ConsoleStatus v-else-if="headerStatus" :label="headerStatus.label" :tone="headerStatus.tone" :pending="headerStatus.pending">
          {{ headerStatus.label }}<template v-if="headerStatus.savedAt">
            · <ConsoleRelativeTime :value="headerStatus.savedAt" prefix="Saved" />
          </template>
        </ConsoleStatus>
      </span>
      <!-- One solid button per view: Save while there are edits, then Publish for a draft or a changed document. -->
      <UTooltip v-if="publishable" text="Save before you publish" :disabled="!dirty">
        <span class="inline-flex">
          <UButton
            :variant="dirty ? 'outline' : 'solid'"
            size="sm"
            :label="state === 'deleted' ? 'Publish deletion' : 'Publish'"
            :disabled="dirty"
            :loading="publishing"
            @click="publish"
          />
        </span>
      </UTooltip>
      <UTooltip v-if="canWrite && !deleted" text="Save" :kbds="['meta', 's']">
        <span class="inline-flex">
          <UButton
            :variant="dirty ? 'solid' : 'ghost'"
            size="sm"
            label="Save"
            :disabled="!dirty"
            :loading="saving"
            @click="save()"
          />
        </span>
      </UTooltip>
      <UDropdownMenu v-if="!missing" :items="menuItems" :content="{ align: 'end' }">
        <UButton variant="ghost" size="sm" icon="i-lucide-ellipsis" aria-label="More actions" />
      </UDropdownMenu>
    </template>
  </UDashboardNavbar>

  <div class="vitehub-document-editor min-h-0 flex-1 overflow-y-auto">
    <UAlert
      v-if="loadError"
      class="m-4"
      color="error"
      variant="subtle"
      icon="i-lucide-cloud-off"
      :title="`Couldn't open this ${noun.toLowerCase()}`"
      :description="consoleErrorMessage(loadError)"
      :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', color: 'neutral', variant: 'outline', onClick: load }]"
    />
    <div v-else-if="loading" class="flex h-full items-center justify-center">
      <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-muted" />
    </div>
    <UEmpty
      v-else-if="missing"
      class="py-16"
      icon="i-lucide-file-question"
      :title="`This ${noun.toLowerCase()} does not exist`"
      description="It may have been deleted and published, or the id is wrong."
      :actions="[{ label: `Back to ${collection.label}`, to: listRoute() }]"
    />
    <UEmpty
      v-else-if="deleted"
      class="py-16"
      icon="i-lucide-file-x"
      title="Deleted from the draft"
      description="It stays on the published site until you publish the deletion. Open History to restore an earlier version."
      :actions="[{ label: 'History', icon: 'i-lucide-history', color: 'neutral', variant: 'outline', onClick: () => (historyOpen = true) }]"
    />
    <div v-else class="mx-auto grid w-full max-w-6xl gap-8 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <div class="grid min-w-0 content-start gap-4">
        <p v-if="!canWrite" class="flex items-center gap-2 rounded-md border border-default px-3 py-2 text-[13px] text-muted">
          <UIcon name="i-lucide-lock" class="size-4 shrink-0" aria-hidden="true" />
          Read-only. You can read drafts of this collection but not change them.
        </p>
        <div v-if="titleField">
          <label :for="`field-${titleField.name}`" class="sr-only">{{ titleField.label }}</label>
          <input
            :id="`field-${titleField.name}`"
            :value="draft.data[titleField.name] ?? ''"
            class="w-full rounded-sm bg-transparent text-2xl font-semibold tracking-[-0.02em] text-highlighted outline-none placeholder:text-dimmed focus-visible:outline-2 focus-visible:outline-offset-4"
            :placeholder="titleField.label"
            :disabled="!canWrite"
            :aria-invalid="fieldErrors[titleField.name] ? 'true' : undefined"
            :aria-describedby="fieldErrors[titleField.name] ? `field-${titleField.name}-error` : undefined"
            @input="draft = { ...draft, data: { ...draft.data, [titleField.name]: ($event.target as HTMLInputElement).value } }"
          >
          <p v-if="fieldErrors[titleField.name]" :id="`field-${titleField.name}-error`" class="mt-1 text-xs text-error">{{ fieldErrors[titleField.name]!.join(" ") }}</p>
        </div>
        <ConsoleMarkdownEditor ref="bodyEditor" v-model="draft.body" :disabled="!canWrite" label="Body" />
      </div>

      <aside class="grid min-w-0 content-start gap-5" aria-label="Document fields">
        <UFormField v-if="creating" label="Id" description="The file path below the collection folder." :error="idError" required :ui="{ label: 'text-xs', description: 'text-xs' }">
          <UInput
            v-model="newId"
            class="w-full"
            :ui="{ base: 'font-mono text-xs' }"
            placeholder="hello-world"
            @update:model-value="idEdited = true"
          />
        </UFormField>
        <dl v-else-if="base" class="grid gap-1 text-xs">
          <dt class="text-muted">File</dt>
          <dd class="truncate font-mono text-highlighted" :title="base.path">{{ base.path }}</dd>
        </dl>
        <ConsoleSchemaForm v-model="draft.data" :schema="sidebarSchema" :errors="fieldErrors" :disabled="!canWrite" />
      </aside>
    </div>
  </div>

  <UModal
    :open="Boolean(conflict)"
    :title="`This ${noun.toLowerCase()} changed since you opened it`"
    description="Someone saved a newer version. Compare it with yours, then choose which one to keep."
    :ui="{ content: 'sm:max-w-3xl' }"
    @update:open="(open) => { if (!open) conflict = undefined }"
  >
    <template #body>
      <div v-if="conflict" class="grid gap-3">
        <p class="text-xs text-muted">
          <span class="font-medium text-highlighted">Removed lines</span> are in the saved version,
          <span class="font-medium text-highlighted">added lines</span> are yours.
          <template v-if="!conflict.theirs"> The saved version deleted this {{ noun.toLowerCase() }}.</template>
        </p>
        <ConsoleDocumentDiff :before="conflict.theirs ? { body: conflict.theirs.body, data: conflict.theirs.data } : null" :after="conflict.mine" :name="`${id}.md`" />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton variant="ghost" label="Keep editing" @click="conflict = undefined" />
        <UButton variant="outline" label="Load theirs" @click="useTheirs" />
        <UButton color="error" label="Overwrite with mine" :loading="saving" @click="keepMine" />
      </div>
    </template>
  </UModal>

  <UModal v-model:open="deleteOpen" :title="`Delete this ${noun.toLowerCase()}?`" :description="`${title} is removed from the draft. It stays on the published site until you publish the deletion, and History can restore it.`">
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" label="Cancel" @click="deleteOpen = false" />
        <UButton color="error" label="Delete" :loading="deleting" @click="remove" />
      </div>
    </template>
  </UModal>

  <USlideover v-model:open="historyOpen" title="History" :description="`Saves and publishes of ${id}`" :ui="{ content: 'sm:max-w-xl', footer: 'justify-end' }">
    <template #body>
      <div v-if="preview" class="grid gap-3">
        <div class="flex items-center gap-2">
          <UButton variant="ghost" size="xs" icon="i-lucide-arrow-left" label="All versions" @click="preview = undefined" />
        </div>
        <div>
          <p class="text-sm font-medium text-highlighted">
            {{ revisionLabel(preview.revision) }} <ConsoleRelativeTime :value="preview.revision.createdAt" /><template v-if="preview.revision.author"> by {{ preview.revision.author }}</template>
          </p>
          <p class="text-xs text-muted">Compared with the saved draft.</p>
        </div>
        <div v-if="previewLoading" class="flex justify-center py-8"><UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-muted" /></div>
        <p v-else-if="!preview.document" class="text-xs text-muted">The {{ noun.toLowerCase() }} does not exist in this version.</p>
        <ConsoleDocumentDiff v-else :before="preview.current?.text ?? null" :after="preview.document.text" :name="`${id}.md`" />
      </div>
      <div v-else class="grid gap-4">
        <UAlert v-if="revisionsError" color="error" variant="subtle" title="Couldn't load history" :description="consoleErrorMessage(revisionsError)" />
        <div v-else-if="revisionsLoading && !revisions.length" class="grid gap-1">
          <USkeleton v-for="index in 4" :key="index" class="h-10 rounded-md" />
        </div>
        <p v-else-if="!revisions.length" class="text-xs text-muted">No versions yet.</p>
        <template v-else>
          <section v-for="group in revisionGroups" :key="group.label" :aria-label="group.label">
            <h3 class="px-2 pb-1 text-xs font-medium text-muted">{{ group.label }}</h3>
            <ol class="grid">
              <li v-for="revision in group.revisions" :key="`${revision.ref}:${revision.id}`">
                <button
                  type="button"
                  class="grid min-h-10 w-full grid-cols-[6.5rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-1.5 text-left hover:bg-elevated focus-visible:outline-2"
                  @click="openRevision(revision)"
                >
                  <ConsoleStatus :label="revisionLabel(revision)" :tone="revisionTone(revision)" class="text-sm text-highlighted" />
                  <span class="flex min-w-0 items-center gap-2 text-[13px] text-muted">
                    <template v-if="revision.author">
                      <UAvatar :text="initials(revision.author)" :alt="revision.author" size="3xs" class="shrink-0" />
                      <span class="truncate">{{ revision.author }}</span>
                    </template>
                    <span class="hidden truncate font-mono text-xs text-dimmed sm:inline">{{ revision.id.slice(0, 7) }}</span>
                  </span>
                  <span class="text-xs text-muted"><ConsoleRelativeTime :value="revision.createdAt" /></span>
                </button>
              </li>
            </ol>
          </section>
        </template>
        <UButton v-if="revisionsCursor" class="justify-self-start" variant="outline" size="xs" label="Older versions" :loading="revisionsLoading" @click="loadRevisions(true)" />
      </div>
    </template>
    <template v-if="preview?.document && canWrite" #footer>
      <UButton icon="i-lucide-rotate-ccw" label="Restore this version" :loading="restoring" @click="restore" />
    </template>
  </USlideover>
</template>
