<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";

import {
  compactConsoleFieldValues,
  consoleDocumentSlug,
  consoleDocumentHasBody,
  consoleDocumentStateColor,
  consoleDocumentStateLabel,
  consoleErrorMessage,
  consoleFieldIssues,
  consoleListQueryFor,
  consolePublishMismatches,
  consoleRevisionLabel,
  consoleSchemaDefaults,
  consoleSeoFallbacks,
  consoleSeoField,
  consoleSingularLabel,
  describeConsoleSchemaFields,
  groupConsoleFieldIssues,
  humanizeConsoleFieldIssues,
  isConsoleConflict,
  isConsoleDocumentId,
  stableConsoleJSON,
} from "../client/documents";
import { splitConsoleFrontmatter } from "../client/editor";
import { useConsoleToast } from "../client/toast";
import ConsoleDocumentDiff from "./console-document-diff.vue";
import ConsoleDocumentHistory from "./console-document-history.vue";
import ConsoleDocumentProperties from "./console-document-properties.vue";
import ConsoleMarkdownEditor from "./console-markdown-editor.vue";
import ConsolePropertyRow from "./console-property-row.vue";
import ConsoleRelativeTime from "./console-relative-time.vue";
import ConsoleSeoPanel from "./console-seo-panel.vue";
import ConsoleStatus from "./console-status.vue";

import type { RouteLocationRaw } from "vue-router";

import type { ConsoleDocument, ConsoleDocumentCollection, ConsoleDocumentRevision, ConsoleDocumentsClient, ConsoleDocumentState, ConsoleRawDocument } from "../client/documents";

/**
 * Edits one document as a page: a large title, the fields as property rows, then the body. Drafts save on their own
 * one second after typing stops, and ⌘S saves at once. Every save sends the digest of the version the editor read, so
 * a save never overwrites a newer version: a conflict pauses saving and offers a comparison. Invalid fields come back
 * from the owner validators and show inline. JSON and YAML documents have no body, so the property rows are the page.
 * A singleton, such as site settings, has no list: it starts from its defaults before its first save.
 */
const props = defineProps<{
  changes: number;
  client: ConsoleDocumentsClient;
  collection: ConsoleDocumentCollection;
  /** Undefined for a new document. */
  documentId?: string;
  /** Where Back leads instead of the collection list, such as the Settings page for a singleton. */
  parent?: { label: string, to: RouteLocationRaw };
}>();

const emit = defineEmits<{ changed: [] }>();

interface Version {
  body: string;
  data: Record<string, unknown>;
}

/** How long typing must pause before the draft saves. */
const autosaveDelay = 1_000;

const route = useRoute();
const router = useRouter();
const toast = useConsoleToast();
const creating = computed(() => props.documentId === undefined);
const single = computed(() => props.collection.kind === "singleton");
const hasBody = computed(() => consoleDocumentHasBody(props.collection));
const fields = computed(() => describeConsoleSchemaFields(props.collection.schema));
const noun = computed(() => consoleSingularLabel(props.collection.label));
// A singleton is named by its label, so every field, a `title` too, is a property row.
const titleField = computed(() => (single.value ? undefined : fields.value.find(field => field.name === props.collection.titleField && field.kind === "string")));
// A `seo()` field gets its own group of rows, with counters and previews, under the other properties.
const seoField = computed(() => consoleSeoField(props.collection.schema));

const loading = ref(!creating.value);
const loadError = ref<unknown>();
/** The version the editor read: the last loaded or saved document. Null for a new or deleted document. */
const base = ref<ConsoleDocument | null>(null);
const state = ref<ConsoleDocumentState | undefined>();
const draft = ref<Version>({ body: "", data: creating.value || single.value ? consoleSchemaDefaults(props.collection.schema) : {} });
const newId = ref("");
const idEdited = ref(false);
const saving = ref(false);
const publishing = ref(false);
/** When this editor last saved, for `Saved 3s ago`. */
const savedAt = ref<string>();
/** Why the last save failed, when the failure is not a field issue or a conflict. */
const saveError = ref<string>();
const fieldErrors = ref<Record<string, string[]>>({});
/** A save that met a newer version. Saving stays paused until someone resolves it. */
const conflict = ref<{ mine: Version, theirs: ConsoleDocument | null }>();
const conflictOpen = ref(false);
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
const bodyEditor = ref<InstanceType<typeof ConsoleMarkdownEditor>>();
const titleInput = ref<HTMLTextAreaElement>();
/** Rich edits the page; Source shows the stored file, with the body editable as Markdown. */
const mode = ref<"rich" | "source">("rich");
/** The stored file of the draft, for Source. */
const storedFile = ref<string>();
const outline = ref<Array<{ id: string, level: number, pos: number, text: string }>>([]);
let mounted = true;
/** `changed` events this editor sent. The section echoes them back through `changes`, which must not reload the page. */
let ownChanges = 0;
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let saveQueued = false;

const canWrite = computed(() => props.collection.access.write);
const canPublish = computed(() => props.collection.access.publish);
const id = computed(() => (creating.value ? newId.value.trim() : props.documentId!));
const savedVersion = computed<Version>(() => (base.value ? { body: base.value.body, data: base.value.data } : { body: "", data: consoleSchemaDefaults(props.collection.schema) }));
const dirty = computed(() => {
  if (creating.value) return Boolean(newId.value.trim()) || stableConsoleJSON(compact(draft.value.data)) !== stableConsoleJSON(compact(savedVersion.value.data)) || Boolean(draft.value.body.trim());
  // A singleton that does not exist yet is dirty once it differs from its defaults.
  if (!base.value) return single.value && state.value !== "deleted" && stableConsoleJSON(compact(draft.value.data)) !== stableConsoleJSON(compact(savedVersion.value.data));
  // The editor writes canonical Markdown, which can drop a trailing newline that the stored file has.
  return draft.value.body.trimEnd() !== base.value.body.trimEnd() || dataDirty.value;
});
const dataDirty = computed(() => Boolean(base.value) && stableConsoleJSON(compact(draft.value.data)) !== stableConsoleJSON(compact(base.value!.data)));
const deleted = computed(() => !creating.value && !loading.value && !base.value && state.value === "deleted");
// A singleton that was never saved opens with its defaults instead.
const missing = computed(() => !single.value && !creating.value && !loading.value && !base.value && !loadError.value && state.value !== "deleted");
const publishable = computed(() => canPublish.value && !creating.value && (dirty.value || state.value === "draft" || state.value === "changed" || state.value === "deleted"));
const title = computed(() => {
  if (single.value) return props.collection.label;
  const value = titleField.value ? draft.value.data[titleField.value.name] : undefined;
  return String(value) === value && value.trim() ? value : creating.value ? `New ${noun.value.toLowerCase()}` : props.documentId!;
});
// The stored file name, such as `hello.md` or `settings.json`, for history and conflict comparisons.
const fileExtension = computed(() => /\.[\w-]+$/.exec(props.collection.path)?.[0] ?? ".md");
const fileName = computed(() => base.value?.path.split("/").pop() ?? `${id.value}${fileExtension.value}`);
const errorCount = computed(() => Object.values(fieldErrors.value).reduce((count, messages) => count + messages.length, 0));
const idError = computed(() => (creating.value && newId.value && !isConsoleDocumentId(newId.value.trim()) ? "Id can use letters, numbers, dashes, and slashes, such as hello-world or 2026/launch." : fieldErrors.value[""]?.join(" ")));
/**
 * Drafts save on their own once they exist. A new document waits for Create, since its id names the file. A singleton
 * has a fixed file, so its first edit creates it.
 */
const autosaves = computed(() => canWrite.value && !creating.value && (Boolean(base.value) || (single.value && state.value !== "deleted")) && !conflict.value && !publishing.value && !restoring.value);
const sourceParts = computed(() => (storedFile.value === undefined ? undefined : splitConsoleFrontmatter(storedFile.value)));

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

type HeaderAction = "conflict" | "fields" | "retry";
/**
 * One status for the header. Problems come first and each one is a button that leads to the fix. Pending edits keep
 * the last save time: they save within a second, so the header does not flicker while someone types.
 */
const headerStatus = computed<{ action?: HeaderAction, label: string, pending?: boolean, savedAt?: string, tone: "error" | "neutral" | "success" | "warning" } | undefined>(() => {
  if (savingVisible.value) return { label: "Saving…", pending: true, tone: "neutral" };
  if (conflict.value) return { action: "conflict", label: "Not saved · newer version", tone: "error" };
  if (errorCount.value) return { action: "fields", label: `${errorCount.value === 1 ? "1 field needs" : `${errorCount.value} fields need`} attention`, tone: "error" };
  if (saveError.value && dirty.value) return { action: "retry", label: "Not saved · retry", tone: "error" };
  if (creating.value) return dirty.value ? { label: "Not created yet", tone: "neutral" } : undefined;
  if (!state.value) return single.value && !base.value && !loading.value ? { label: "Not saved yet", tone: "neutral" } : undefined;
  const label = dirty.value && !autosaves.value ? "Unsaved" : consoleDocumentStateLabel(state.value);
  return { label, savedAt: savedAt.value ?? base.value?.updatedAt ?? undefined, tone: dirty.value && !autosaves.value ? "warning" : consoleDocumentStateColor(state.value) };
});

function notifyChanged(): void {
  ownChanges++;
  emit("changed");
}

function updateSeo(value: Record<string, unknown> | undefined): void {
  if (!seoField.value) return;
  const data = { ...draft.value.data };
  if (value === undefined) delete data[seoField.value.name];
  else data[seoField.value.name] = value;
  draft.value = { ...draft.value, data };
}

function compact(data: Record<string, unknown>): Record<string, unknown> {
  return compactConsoleFieldValues(fields.value, data);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** Back leads to the parent page, or to the collection list. A singleton has no list. */
const back = computed(() => props.parent ?? (single.value ? undefined : { label: props.collection.label, to: listRoute() }));

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
    // Someone typed while the document loaded: keep their edits and the version they started from.
    if (document && base.value && dirty.value) return;
    if (document) accept(document);
    else {
      base.value = null;
      if (single.value) draft.value = { body: "", data: consoleSchemaDefaults(props.collection.schema) };
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
/** The body when the owner validators last rejected the draft. Autosave retries once the body or a field changes. */
let errorBody = "";
watch(() => draft.value.data, (data) => {
  if (!errorCount.value) return;
  const next = Object.fromEntries(Object.entries(fieldErrors.value).filter(([path]) => {
    const name = path.split(".")[0] ?? "";
    return !name || stableConsoleJSON(data[name] ?? null) === errorSnapshot[name];
  }));
  if (Object.keys(next).length !== Object.keys(fieldErrors.value).length) fieldErrors.value = next;
}, { deep: true });

/**
 * Saves the draft. An autosave never moves focus or opens a dialog: invalid fields and conflicts show in the header
 * and inline, and saving pauses until the next edit or until someone resolves the conflict.
 */
async function save(options: { auto?: boolean, ifDigest?: string | null } = {}): Promise<void> {
  if (!canWrite.value) return;
  // ⌘S during a save, such as an autosave in flight, saves again right after it.
  if (saving.value) {
    if (!options.auto) saveQueued = true;
    return;
  }
  clearTimeout(autosaveTimer);
  await bodyEditor.value?.commit();
  if (creating.value && !isConsoleDocumentId(id.value)) {
    fieldErrors.value = { "": [id.value ? "Id can use letters, numbers, dashes, and slashes." : "Id is required."] };
    errorSnapshot = {};
    await focusFirstInvalid();
    return;
  }
  saving.value = true;
  const failedBefore = Boolean(saveError.value);
  saveError.value = undefined;
  const sent: Version = { body: draft.value.body, data: compact(draft.value.data) };
  try {
    const saved = await props.client.save(props.collection.name, id.value, {
      ...sent,
      ifDigest: options.ifDigest !== undefined ? options.ifDigest : base.value?.digest ?? null,
    });
    fieldErrors.value = {};
    conflict.value = undefined;
    conflictOpen.value = false;
    // Keep edits made while the save was running.
    const editedDuringSave = draft.value.body !== sent.body || stableConsoleJSON(compact(draft.value.data)) !== stableConsoleJSON(sent.data);
    base.value = saved;
    state.value = saved.state;
    if (!editedDuringSave) draft.value = { body: saved.body === sent.body ? draft.value.body : saved.body, data: clone(saved.data) };
    savedAt.value = new Date().toISOString();
    notifyChanged();
    // The saved document opens at its own route. The history state tells the new editor when it saved.
    if (creating.value) await router.replace({ ...documentRoute(saved.id), state: { vitehubDocumentSavedAt: savedAt.value } });
    if (revisions.value.length || historyOpen.value || panel.value === "history") void loadRevisions();
    if (mode.value === "source") void loadStoredFile();
  }
  catch (error) {
    const issues = consoleFieldIssues(error);
    if (issues) {
      fieldErrors.value = groupConsoleFieldIssues(humanizeConsoleFieldIssues(fields.value, issues));
      errorSnapshot = Object.fromEntries(Object.entries(draft.value.data).map(([name, value]) => [name, stableConsoleJSON(value ?? null)]));
      errorBody = sent.body;
      if (!options.auto) await focusFirstInvalid();
    }
    else if (isConsoleConflict(error)) {
      const theirs = await props.client.get(props.collection.name, id.value).catch(() => null);
      conflict.value = { mine: sent, theirs };
      const compare = () => {
        conflictOpen.value = true;
      };
      if (options.auto) toast.error("Someone saved a newer version. Saving is paused.", { label: "Compare", onClick: compare });
      else compare();
    }
    else {
      saveError.value = consoleErrorMessage(error, "The request failed.");
      // One toast per failure streak, so an autosave that keeps failing does not stack toasts.
      if (!options.auto || !failedBefore) toast.error("Couldn't save. Try again.", { label: "Retry", onClick: () => save() });
    }
  }
  finally {
    saving.value = false;
  }
  if (saveQueued) {
    saveQueued = false;
    if (dirty.value) return await save();
  }
  // Edits made during the save, or a failed autosave that someone edited past, save on the next pause.
  if (dirty.value && !saveError.value) scheduleAutosave();
}

/** Resolves once no save is running, such as an autosave that started just before a publish. */
function settled(): Promise<void> {
  if (!saving.value) return Promise.resolve();
  return new Promise(resolve => {
    const stop = watch(saving, (value) => {
      if (value) return;
      stop();
      resolve();
    });
  });
}

function scheduleAutosave(): void {
  clearTimeout(autosaveTimer);
  if (!autosaves.value) return;
  autosaveTimer = setTimeout(() => {
    if (!dirty.value || !autosaves.value) return;
    // A field the owner validators rejected stays rejected until someone changes it.
    if (errorCount.value && !dataChangedSinceErrors()) return;
    void save({ auto: true });
  }, autosaveDelay);
}

function dataChangedSinceErrors(): boolean {
  return Object.entries(errorSnapshot).some(([name, value]) => stableConsoleJSON(draft.value.data[name] ?? null) !== value) || draft.value.body !== errorBody;
}

watch(draft, () => {
  if (dirty.value) scheduleAutosave();
}, { deep: true });

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
  conflictOpen.value = false;
  if (theirs) accept(theirs);
  else void load();
}

/**
 * Publishes the draft on screen. Pending edits save first, and the publish names the digest of that save, so a save
 * from someone else in between fails the publish instead of publishing their draft unseen.
 */
async function publish(): Promise<void> {
  if (!canPublish.value || publishing.value) return;
  clearTimeout(autosaveTimer);
  await bodyEditor.value?.commit();
  await settled();
  if (dirty.value) {
    await save();
    if (dirty.value || conflict.value || errorCount.value || saveError.value) return;
  }
  const before = state.value;
  const removing = deleted.value;
  publishing.value = true;
  if (!removing) state.value = "published";
  try {
    // Publish exactly the draft on screen. A deleted document has no draft to expect.
    const result = await props.client.publish(props.collection.name, [{ digest: base.value?.digest ?? null, id: id.value }]);
    if (result.documents.length) toast.show({ title: removing ? `${noun.value} removed from the site` : "Changes published" });
    notifyChanged();
    if (removing) await router.replace(listRoute());
    // Edits made while publishing stay on screen and save as the next draft.
    else if (!dirty.value) await load();
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
      errorBody = draft.value.body;
      toast.error("This draft no longer validates. Fix it, then publish.");
      await focusFirstInvalid();
    }
    else toast.error("Couldn't publish. Try again.", { label: "Retry", onClick: publish });
  }
  finally {
    publishing.value = false;
  }
  if (dirty.value) scheduleAutosave();
}

async function remove(): Promise<void> {
  clearTimeout(autosaveTimer);
  await settled();
  if (!base.value) return;
  const removed = { id: id.value, revision: base.value.revision };
  const { client, collection } = props;
  deleting.value = true;
  try {
    await client.remove(collection.name, removed.id, base.value.digest);
    deleteOpen.value = false;
    base.value = null;
    notifyChanged();
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
  historyOpen.value = true;
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
  clearTimeout(autosaveTimer);
  await bodyEditor.value?.commit();
  await settled();
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
    notifyChanged();
    void loadRevisions();
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
            notifyChanged();
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

async function loadStoredFile(): Promise<void> {
  if (creating.value || !base.value) {
    storedFile.value = undefined;
    return;
  }
  try {
    storedFile.value = (await props.client.raw(props.collection.name, id.value))?.text;
  }
  catch {
    storedFile.value = undefined;
  }
}

// Write pending body edits first, so a shortcut pressed right after typing still saves them.
async function saveFromShortcut(): Promise<void> {
  await bodyEditor.value?.commit();
  if (dirty.value || conflict.value) await save();
}

function toggleMode(): void {
  mode.value = mode.value === "rich" ? "source" : "rich";
}

function onKeydown(event: KeyboardEvent): void {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
  if (event.key.toLowerCase() === "s") {
    event.preventDefault();
    void saveFromShortcut();
  }
  if (event.key === "/" && !creating.value && hasBody.value) {
    event.preventDefault();
    toggleMode();
  }
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!dirty.value) return;
  event.preventDefault();
}

function onHeaderAction(action: HeaderAction | undefined): void {
  if (action === "conflict") conflictOpen.value = true;
  if (action === "fields") void focusFirstInvalid();
  if (action === "retry") void save();
}

// Title: a large borderless field. Enter moves to the body, as in Notion.
function resizeTitle(): void {
  const input = titleInput.value;
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}

function onTitleInput(event: Event): void {
  if (!titleField.value || !(event.target instanceof HTMLTextAreaElement)) return;
  const value = event.target.value.replace(/\r?\n/g, " ");
  draft.value = { ...draft.value, data: { ...draft.value.data, [titleField.value.name]: value } };
  resizeTitle();
}

function onTitleKeydown(event: KeyboardEvent): void {
  const input = event.target;
  if (!(input instanceof HTMLTextAreaElement)) return;
  if (event.key === "Enter" && !event.isComposing && !(event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    bodyEditor.value?.focus("start");
  }
  if (event.key === "ArrowDown" && input.selectionStart === input.value.length) {
    event.preventDefault();
    bodyEditor.value?.focus("start");
  }
}

// Right rail: Outline or History, kept in the URL as `?panel=history`.
const panel = computed<"history" | "outline" | undefined>(() => (route.query.panel === "history" || route.query.panel === "outline" ? route.query.panel : undefined));
function setPanel(next: "history" | "outline" | undefined): void {
  const query = { ...route.query };
  if (next) query.panel = next;
  else delete query.panel;
  void router.replace({ query });
}
function openHistory(): void {
  if (window.matchMedia("(min-width: 1024px)").matches) setPanel("history");
  else historyOpen.value = true;
}

// The id follows the title until someone edits the id.
watch(() => (titleField.value ? draft.value.data[titleField.value.name] : undefined), (value) => {
  if (creating.value && !idEdited.value) newId.value = consoleDocumentSlug(String(value ?? ""));
  void nextTick(resizeTitle);
});
watch(historyOpen, (open) => {
  if (open && !revisions.value.length) void loadRevisions();
  if (!open) preview.value = undefined;
});
watch(panel, (value) => {
  if (value === "history") void loadRevisions();
}, { immediate: true });
watch(mode, (value) => {
  if (value === "source") void loadStoredFile();
});
watch(() => props.changes, (next, previous) => {
  const own = Math.min(ownChanges, next - previous);
  ownChanges -= own;
  if (next - previous - own <= 0) return;
  if (!dirty.value && !creating.value && !saving.value && !publishing.value) void load();
});

onBeforeRouteLeave(async () => {
  if (!dirty.value) return;
  // A pending autosave finishes before leaving. Anything that cannot save asks first.
  await settled();
  if (dirty.value && autosaves.value) await save({ auto: true });
  if (dirty.value && !window.confirm(creating.value ? "Leave without creating this document?" : "Leave without saving? Your changes will be lost.")) return false;
});
onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("beforeunload", onBeforeUnload);
  const saved: unknown = window.history.state?.vitehubDocumentSavedAt;
  if (String(saved) === saved) savedAt.value = saved;
  void load().then(() => nextTick(resizeTitle));
  // A new document starts at its title.
  if (creating.value) void nextTick(() => titleInput.value?.focus());
});
onBeforeUnmount(() => {
  mounted = false;
  clearTimeout(savingShowTimer);
  clearTimeout(savingHideTimer);
  clearTimeout(autosaveTimer);
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("beforeunload", onBeforeUnload);
});

const menuItems = computed(() => [[
  ...(!creating.value ? [{ label: "History", icon: "i-lucide-history", onSelect: openHistory }] : []),
  ...(!creating.value && hasBody.value ? [{ label: mode.value === "rich" ? "View source" : "Edit rich text", icon: "i-lucide-file-code", kbds: ["meta", "/"], onSelect: toggleMode }] : []),
  { label: "Copy id", icon: "i-lucide-copy", onSelect: () => void navigator.clipboard?.writeText(id.value) },
  ...(base.value ? [{ label: "Copy path", icon: "i-lucide-folder", onSelect: () => void navigator.clipboard?.writeText(base.value!.path) }] : []),
], ...(canWrite.value && base.value && !single.value ? [[{ label: "Delete", icon: "i-lucide-trash-2", color: "error" as const, onSelect: () => (deleteOpen.value = true) }]] : [])]);
</script>

<template>
  <UDashboardNavbar :ui="{ root: 'border-b border-default', right: 'gap-1.5' }" :toggle="{ 'aria-label': 'Open collections' }">
    <template v-if="back" #leading>
      <UButton :to="back.to" variant="ghost" size="sm" icon="i-lucide-arrow-left" :aria-label="`Back to ${back.label}`" />
    </template>
    <template #title>
      <span class="flex min-w-0 items-center gap-2">
        <template v-if="back">
          <RouterLink :to="back.to" class="hidden shrink-0 text-sm font-normal text-muted hover:text-highlighted sm:inline">{{ back.label }}</RouterLink>
          <span class="hidden text-dimmed sm:inline" aria-hidden="true">/</span>
        </template>
        <span class="truncate text-sm font-medium text-highlighted">{{ title }}</span>
      </span>
    </template>
    <template #right>
      <span class="me-1 hidden sm:inline-flex" role="status" aria-live="polite">
        <button
          v-if="headerStatus?.action && !savingVisible"
          type="button"
          class="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2"
          @click="onHeaderAction(headerStatus.action)"
        >
          <ConsoleStatus :label="headerStatus.label" :tone="headerStatus.tone" class="underline decoration-dotted underline-offset-4 hover:text-highlighted" />
        </button>
        <UTooltip v-else-if="headerStatus" :text="creating ? 'Create saves the first draft' : 'Drafts save as you type. ⌘S saves now.'" :content="{ side: 'bottom' }">
          <ConsoleStatus :label="headerStatus.label" :tone="headerStatus.tone" :pending="headerStatus.pending">
            {{ headerStatus.label }}<template v-if="headerStatus.savedAt">
              · <ConsoleRelativeTime :value="headerStatus.savedAt" prefix="Saved" seconds />
            </template>
          </ConsoleStatus>
        </UTooltip>
      </span>
      <div
        v-if="hasBody && !creating && !missing && !deleted && !loadError"
        class="hidden items-center rounded-md p-0.5 ring-1 ring-default ring-inset md:flex"
        role="radiogroup"
        aria-label="Editing mode"
      >
        <UTooltip v-for="option in [{ label: 'Rich', value: 'rich' }, { label: 'Source', value: 'source' }] as const" :key="option.value" :text="option.value === 'rich' ? 'Edit as a page' : 'The stored Markdown file'" :kbds="['meta', '/']">
          <button
            type="button"
            role="radio"
            class="h-6 rounded-[4px] px-2 text-xs focus-visible:outline-2"
            :class="mode === option.value ? 'bg-elevated text-highlighted' : 'text-muted hover:text-highlighted'"
            :aria-checked="mode === option.value"
            @click="mode = option.value"
          >
            {{ option.label }}
          </button>
        </UTooltip>
      </div>
      <UButton v-if="creating && canWrite" size="sm" label="Create" :loading="saving" @click="save()" />
      <UButton
        v-else-if="publishable"
        size="sm"
        :label="state === 'deleted' ? 'Publish deletion' : 'Publish'"
        :loading="publishing"
        :disabled="Boolean(conflict)"
        @click="publish"
      />
      <UTooltip v-if="!creating && !missing" text="Outline and history" :content="{ side: 'bottom' }">
        <UButton
          class="hidden lg:inline-flex"
          variant="ghost"
          size="sm"
          icon="i-lucide-panel-right"
          aria-label="Toggle the side panel"
          :active="Boolean(panel)"
          active-variant="soft"
          @click="setPanel(panel ? undefined : hasBody ? 'outline' : 'history')"
        />
      </UTooltip>
      <UDropdownMenu v-if="!missing" :items="menuItems" :content="{ align: 'end' }">
        <UButton variant="ghost" size="sm" icon="i-lucide-ellipsis" aria-label="More actions" />
      </UDropdownMenu>
    </template>
  </UDashboardNavbar>

  <div class="flex min-h-0 flex-1">
    <div class="vitehub-document-editor min-h-0 min-w-0 flex-1 overflow-y-auto">
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
      <article v-else class="mx-auto w-full max-w-[52rem] px-6 pt-10 pb-8 sm:px-16 sm:pt-14">
        <p v-if="!canWrite" class="mb-6 flex items-center gap-2 text-[13px] text-muted">
          <UIcon name="i-lucide-lock" class="size-4 shrink-0" aria-hidden="true" />
          Read-only. You can read drafts of this collection but not change them.
        </p>

        <template v-if="mode === 'rich'">
          <h1 v-if="single" class="mb-4 text-[32px]/[40px] font-semibold tracking-[-0.04rem] text-highlighted">{{ collection.label }}</h1>
          <div v-else-if="titleField" class="mb-4">
            <label :for="`field-${titleField.name}`" class="sr-only">{{ titleField.label }}</label>
            <textarea
              :id="`field-${titleField.name}`"
              ref="titleInput"
              :value="String(draft.data[titleField.name] ?? '')"
              rows="1"
              class="block w-full resize-none overflow-hidden rounded-sm bg-transparent text-[32px]/[40px] font-semibold tracking-[-0.04rem] text-highlighted outline-none placeholder:text-dimmed focus-visible:outline-none disabled:cursor-default"
              :placeholder="`${noun} title`"
              :disabled="!canWrite"
              :aria-invalid="fieldErrors[titleField.name] ? 'true' : undefined"
              :aria-describedby="fieldErrors[titleField.name] ? `field-${titleField.name}-error` : undefined"
              @input="onTitleInput"
              @keydown="onTitleKeydown"
            />
            <p v-if="fieldErrors[titleField.name]" :id="`field-${titleField.name}-error`" class="mt-1 text-xs text-error">{{ fieldErrors[titleField.name]!.join(" ") }}</p>
          </div>

          <ConsoleDocumentProperties
            v-model="draft.data"
            :schema="collection.schema"
            :exclude="[titleField?.name, seoField?.name].filter(name => name !== undefined)"
            :errors="fieldErrors"
            :disabled="!canWrite"
            :unfolded="!hasBody"
            @submit="saveFromShortcut"
          >
            <ConsolePropertyRow v-if="creating" icon="i-lucide-file" label="Id" control="field-id" :error="idError" :missing="!newId.trim() && !idError">
              <UInput
                id="field-id"
                v-model="newId"
                class="w-full"
                variant="ghost"
                placeholder="hello-world"
                :ui="{ base: 'bg-transparent hover:bg-transparent focus:bg-transparent ring-0 hover:ring-1 hover:ring-inset hover:ring-(--ui-border) focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-(--ui-border-accented) font-mono text-xs', trailing: 'pe-2' }"
                :aria-invalid="idError ? 'true' : undefined"
                :aria-describedby="idError ? 'field-id-error' : 'field-id-hint'"
                @update:model-value="idEdited = true"
              >
                <template #trailing>
                  <span id="field-id-hint" class="text-xs text-dimmed">{{ idEdited ? `${collection.path.split('*')[0]}${newId || '…'}${fileExtension}` : "From the title" }}</span>
                </template>
              </UInput>
            </ConsolePropertyRow>
            <ConsolePropertyRow v-else-if="base" icon="i-lucide-file" label="File">
              <span class="flex h-8 min-w-0 items-center px-2.5 font-mono text-xs text-muted" :title="base.path">
                <span class="truncate">{{ base.path }}</span>
              </span>
            </ConsolePropertyRow>
          </ConsoleDocumentProperties>

          <ConsoleSeoPanel
            v-if="seoField"
            :model-value="draft.data[seoField.name] as Record<string, unknown> | undefined"
            :name="seoField.name"
            :schema="seoField.schema"
            :hint="seoField.hint"
            :fallbacks="consoleSeoFallbacks(draft.data, collection.titleField, base?.url)"
            :errors="fieldErrors"
            :disabled="!canWrite"
            @update:model-value="updateSeo"
          />

          <hr v-if="hasBody" class="my-6 border-default">
        </template>

        <section v-else class="mb-4 grid gap-3" aria-label="Stored file">
          <div class="flex items-center gap-2 text-xs text-muted">
            <UIcon name="i-lucide-file-code" class="size-4 shrink-0" aria-hidden="true" />
            <span class="font-mono text-highlighted">{{ base?.path }}</span>
            <span class="ms-auto">{{ dataDirty ? "Fields are saving…" : "Fields are read-only here. Edit them in Rich." }}</span>
          </div>
          <pre
            v-if="sourceParts?.frontmatter"
            class="overflow-x-auto rounded-md bg-elevated/50 px-4 py-3 font-mono text-[13px]/6 text-muted select-text"
            aria-label="Frontmatter, read-only"
          >{{ sourceParts.frontmatter.trimEnd() }}</pre>
        </section>

        <ConsoleMarkdownEditor
          v-if="hasBody"
          v-show="mode === 'rich'"
          ref="bodyEditor"
          v-model="draft.body"
          :active="mode === 'rich'"
          :collection="collection.name"
          :components="collection.components"
          :document-id="creating ? undefined : id"
          :disabled="!canWrite"
          label="Body"
          @outline="outline = $event"
        />
        <UTextarea
          v-if="hasBody && mode === 'source'"
          v-model="draft.body"
          :disabled="!canWrite"
          autoresize
          :rows="16"
          variant="none"
          class="w-full"
          :ui="{ base: 'min-h-80 p-0 font-mono text-[13px] leading-6' }"
          aria-label="Markdown body"
        />
      </article>
    </div>

    <aside v-if="panel && !creating && !missing" class="hidden w-72 shrink-0 flex-col border-s border-default lg:flex" aria-label="Side panel">
      <div class="flex h-11 shrink-0 items-center gap-1 border-b border-default px-2">
        <UButton
          v-for="option in (hasBody ? [{ label: 'Outline', value: 'outline' }, { label: 'History', value: 'history' }] as const : [{ label: 'History', value: 'history' }] as const)"
          :key="option.value"
          size="xs"
          variant="ghost"
          :label="option.label"
          :active="panel === option.value"
          active-variant="soft"
          :aria-pressed="panel === option.value"
          @click="setPanel(option.value)"
        />
        <UButton class="ms-auto" size="xs" variant="ghost" icon="i-lucide-x" aria-label="Close the side panel" @click="setPanel(undefined)" />
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-2">
        <nav v-if="panel === 'outline'" aria-label="Outline">
          <p v-if="!outline.length" class="px-2 py-1.5 text-xs text-muted">Headings in the body show here.</p>
          <ol v-else class="grid">
            <li v-for="heading in outline" :key="`${heading.pos}`">
              <button
                type="button"
                class="block w-full truncate rounded-md py-1 pe-2 text-left text-[13px] text-muted hover:bg-elevated/60 hover:text-highlighted focus-visible:outline-2"
                :style="{ paddingInlineStart: `${0.5 + (heading.level - 1) * 0.75}rem` }"
                @click="bodyEditor?.scrollTo(heading.pos)"
              >
                {{ heading.text }}
              </button>
            </li>
          </ol>
        </nav>
        <ConsoleDocumentHistory
          v-else
          :revisions="revisions"
          :cursor="revisionsCursor"
          :loading="revisionsLoading"
          :error="revisionsError"
          :loaded-at="revisionsLoadedAt"
          :selected="historyOpen ? preview?.revision.id : undefined"
          @open="openRevision"
          @more="loadRevisions(true)"
        />
      </div>
    </aside>
  </div>

  <UModal
    :open="conflictOpen && Boolean(conflict)"
    :title="`This ${noun.toLowerCase()} changed since you opened it`"
    description="Someone saved a newer version, so saving paused. Compare it with yours, then choose which one to keep."
    :ui="{ content: 'sm:max-w-3xl' }"
    @update:open="(open) => { if (!open) conflictOpen = false }"
  >
    <template #body>
      <div v-if="conflict" class="grid gap-3">
        <p class="text-xs text-muted">
          <span class="font-medium text-highlighted">Removed lines</span> are in the saved version,
          <span class="font-medium text-highlighted">added lines</span> are yours.
          <template v-if="!conflict.theirs"> The saved version deleted this {{ noun.toLowerCase() }}.</template>
        </p>
        <ConsoleDocumentDiff :before="conflict.theirs ? { body: conflict.theirs.body, data: conflict.theirs.data } : null" :after="conflict.mine" :format="collection.format" :name="fileName" />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton variant="ghost" label="Keep editing" @click="conflictOpen = false" />
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
            {{ consoleRevisionLabel(preview.revision) }} <ConsoleRelativeTime :value="preview.revision.createdAt" /><template v-if="preview.revision.author"> by {{ preview.revision.author }}</template>
          </p>
          <p class="text-xs text-muted">Compared with the saved draft.</p>
        </div>
        <div v-if="previewLoading" class="flex justify-center py-8"><UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-muted" /></div>
        <p v-else-if="!preview.document" class="text-xs text-muted">The {{ noun.toLowerCase() }} does not exist in this version.</p>
        <ConsoleDocumentDiff v-else :before="preview.current?.text ?? null" :after="preview.document.text" :format="collection.format" :name="fileName" />
      </div>
      <ConsoleDocumentHistory
        v-else
        :revisions="revisions"
        :cursor="revisionsCursor"
        :loading="revisionsLoading"
        :error="revisionsError"
        :loaded-at="revisionsLoadedAt"
        @open="openRevision"
        @more="loadRevisions(true)"
      />
    </template>
    <template v-if="preview?.document && canWrite" #footer>
      <UButton icon="i-lucide-rotate-ccw" label="Restore this version" :loading="restoring" @click="restore" />
    </template>
  </USlideover>
</template>
