<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";

import { consoleErrorMessage } from "../client/documents";
import {
  consoleFolderName,
  consoleFocalCropPosition,
  consoleFolderTrail,
  consoleMediaAccepts,
  consoleMediaFormat,
  consoleMediaTransformable,
  consoleMediaType,
  consoleMediaTypeIcons,
  consoleMediaUrl,
  consoleMediaVariantUrl,
} from "../client/media-library";
import { consoleBytes } from "../client/format";
import { useConsoleMediaUploads } from "../client/media-uploads";
import { useConsoleToast } from "../client/toast";
import ConsoleMediaMove from "./console-media-move.vue";
import ConsoleMediaUploads from "./console-media-uploads.vue";
import ConsolePageToolbar from "./console-page-toolbar.vue";
import ConsoleRelativeTime from "./console-relative-time.vue";

import type { ConsoleMediaAccess, ConsoleMediaClient, ConsoleMediaFile, ConsoleMediaReferenceDocument, ConsoleMediaType, ConsoleMediaUploadResult } from "../client/media-library";

/**
 * Browses one folder of the media library: breadcrumbs, folders, and files in a grid or a list, search by file name
 * across subfolders, a type filter, and uploads by button or by dropping files anywhere on it. On the Media page it
 * selects files for bulk moves and deletes and opens one in the detail panel. In the picker it selects files to insert.
 */
const props = defineProps<{
  /** Content types the picker accepts, such as `["image/*"]`. Other files show but cannot be picked. */
  accept?: readonly string[];
  /** The file whose details are open, on the Media page. */
  active?: string;
  client: ConsoleMediaClient;
  mode: "page" | "picker";
  /** The picker may pick more than one file. */
  multiple?: boolean;
  /** Where the Media page shows New folder and Upload: its page header. Without it, they stay in the toolbar. */
  actionsTarget?: HTMLElement | null;
  /** The name of the root folder, such as Media. */
  rootLabel?: string;
  /** The empty state text of a folder, such as for a read-only store. */
  emptyDescription?: string;
  /** The search placeholder, such as `Filter by prefix…` for a store that lists by prefix. */
  searchPlaceholder?: string;
  /** The view when the viewer has not picked one, and the key that remembers their pick. */
  defaultView?: "grid" | "list";
  viewKey?: string;
}>();

const emit = defineEmits<{
  /** The picker confirmed its selection with a double click or Enter. */
  confirm: [];
  /** The access and served URL of the store, once the first listing loads. */
  info: [info: { access: ConsoleMediaAccess, served: string | null }];
  /** Open the details of a file, on the Media page. */
  open: [file: ConsoleMediaFile | undefined];
  /** Files changed: uploaded, moved, or deleted. */
  changed: [];
}>();

const folder = defineModel<string>("folder", { default: "" });
const selected = defineModel<string[]>("selected", { default: () => [] });

const toast = useConsoleToast();
const items = shallowRef<ConsoleMediaFile[]>([]);
const folders = ref<string[]>([]);
const access = ref<ConsoleMediaAccess>({ manage: false, read: true, write: false });
const served = ref<string | null>(null);
const cursor = ref<string>();
const truncated = ref(false);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref<unknown>();
const search = ref("");
const query = ref("");
const type = ref<ConsoleMediaType | "all">("all");
const viewKey = props.viewKey ?? "vitehub:console:media-view";
const storedView = globalThis.localStorage?.getItem(viewKey);
const view = ref<"grid" | "list">(storedView === "list" || storedView === "grid" ? storedView : props.defaultView ?? "grid");
/** Every file this browser has listed, so a selection survives a change of folder. */
const known = new Map<string, ConsoleMediaFile>();
let anchor: string | undefined;
let request = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

watch(view, value => globalThis.localStorage?.setItem(viewKey, value));

const typeItems = [
  { label: "All types", value: "all" },
  { label: "Images", value: "image" },
  { label: "Videos", value: "video" },
  { label: "Audio", value: "audio" },
  { label: "Documents", value: "document" },
  { label: "Other", value: "other" },
];
const trail = computed(() => consoleFolderTrail(folder.value));
/** A folder's name, or the root's name, such as Media. */
const folderLabel = (path: string) => (path ? consoleFolderName(path) : props.rootLabel ?? consoleFolderName(path));
const searching = computed(() => Boolean(query.value));
/** Stores without image dimensions, such as a raw Blob Store, leave the Dimensions column out. */
const hasDimensions = computed(() => items.value.some(file => file.width && file.height));
const selectedSet = computed(() => new Set(selected.value));
const selecting = computed(() => selected.value.length > 0);
/** Selection exists for bulk moves and deletes on the page, and for picking several files in the picker. */
const canSelect = computed(() => (props.mode === "page" ? access.value.manage : Boolean(props.multiple)));
const pickable = (file: ConsoleMediaFile) => props.mode !== "picker" || consoleMediaAccepts(props.accept, file.contentType);

async function load(options: { more?: boolean } = {}): Promise<void> {
  const current = ++request;
  if (options.more) loadingMore.value = true;
  else loading.value = true;
  try {
    const listing = await props.client.list({
      ...(folder.value ? { folder: folder.value } : {}),
      ...(query.value ? { search: query.value } : {}),
      ...(type.value === "all" ? {} : { type: type.value }),
      ...(options.more && cursor.value ? { cursor: cursor.value } : {}),
    });
    if (current !== request) return;
    for (const file of listing.items) known.set(file.pathname, file);
    items.value = options.more ? [...items.value, ...listing.items] : listing.items;
    if (!options.more) folders.value = listing.folders;
    cursor.value = listing.cursor;
    truncated.value = listing.truncated === true;
    access.value = listing.access;
    served.value = listing.served;
    error.value = undefined;
    emit("info", { access: listing.access, served: listing.served });
  }
  catch (requestError) {
    if (current === request) error.value = requestError;
  }
  finally {
    if (current === request) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

watch(folder, () => {
  if (props.mode === "page") selected.value = [];
  void load();
});
watch(type, () => void load());
watch(search, (value) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    query.value = value.trim();
    void load();
  }, 200);
});

onMounted(() => void load());

function open(path: string): void {
  search.value = "";
  query.value = "";
  folder.value = path;
}

function thumbnail(file: ConsoleMediaFile, size = 256): string | undefined {
  const url = file.url ?? consoleMediaUrl(served.value, file.pathname);
  if (!url || consoleMediaType(file.contentType) !== "image") return undefined;
  return consoleMediaTransformable(file.contentType) ? consoleMediaVariantUrl(url, { fit: "cover", height: size, version: file.updatedAt, width: size }) : url;
}

/** Thumbnails fade in once decoded, over the dominant color, instead of painting line by line. */
function loaded(event: Event): void {
  if (event.target instanceof HTMLImageElement) event.target.dataset.loaded = "";
}

function meta(file: ConsoleMediaFile): string {
  return file.width && file.height ? `${file.width} × ${file.height}` : `${consoleMediaFormat(file)} · ${consoleBytes(file.size)}`;
}

// Selection

function toggle(file: ConsoleMediaFile): void {
  if (!pickable(file)) return;
  anchor = file.pathname;
  if (props.mode === "picker" && !props.multiple) {
    selected.value = selectedSet.value.has(file.pathname) ? [] : [file.pathname];
    return;
  }
  selected.value = selectedSet.value.has(file.pathname) ? selected.value.filter(pathname => pathname !== file.pathname) : [...selected.value, file.pathname];
}

function range(file: ConsoleMediaFile): void {
  const index = items.value.findIndex(item => item.pathname === file.pathname);
  const from = anchor ? items.value.findIndex(item => item.pathname === anchor) : -1;
  if (from === -1 || index === -1) {
    toggle(file);
    return;
  }
  const [start, end] = from < index ? [from, index] : [index, from];
  const span = items.value.slice(start, end + 1).filter(pickable).map(item => item.pathname);
  selected.value = [...new Set([...selected.value, ...span])];
}

function click(file: ConsoleMediaFile, event: MouseEvent): void {
  if (event.shiftKey && canSelect.value) {
    range(file);
    return;
  }
  if (props.mode === "picker" || (canSelect.value && (event.metaKey || event.ctrlKey || selecting.value))) {
    toggle(file);
    return;
  }
  anchor = file.pathname;
  emit("open", file);
}

function activate(file: ConsoleMediaFile): void {
  if (props.mode !== "picker" || !pickable(file)) return;
  if (!selectedSet.value.has(file.pathname)) {
    if (props.multiple) selected.value = [...selected.value, file.pathname];
    else selected.value = [file.pathname];
  }
  emit("confirm");
}

function keydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement;
  if (target.closest("input, textarea, [contenteditable=true]")) return;
  if (event.key === "Escape" && selecting.value && props.mode === "page") {
    event.preventDefault();
    selected.value = [];
  }
  else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a" && canSelect.value) {
    event.preventDefault();
    selected.value = items.value.filter(pickable).map(item => item.pathname);
  }
  else if ((event.key === "Backspace" || event.key === "Delete") && selecting.value && props.mode === "page" && access.value.manage) {
    event.preventDefault();
    void askRemove(selectedFiles());
  }
}

function selectedFiles(): ConsoleMediaFile[] {
  return selected.value.flatMap(pathname => known.get(pathname) ?? []);
}

// Uploads

const uploads = useConsoleMediaUploads(() => props.client, (result) => {
  known.set(result.file.pathname, result.file);
  // A new file in this folder joins the listing at once; a duplicate already lives elsewhere.
  if (!result.duplicate && !searching.value && result.file.pathname.slice(0, Math.max(0, result.file.pathname.lastIndexOf("/"))) === folder.value) {
    items.value = [result.file, ...items.value.filter(item => item.pathname !== result.file.pathname)];
  }
});
const fileInput = ref<HTMLInputElement>();
const dragDepth = ref(0);

async function upload(files: readonly File[]): Promise<ConsoleMediaUploadResult[]> {
  if (!files.length) return [];
  if (!access.value.write) {
    toast.error("You cannot upload files here. Ask for write access to a collection.");
    return [];
  }
  const results = await uploads.add(files, folder.value);
  if (results.length) emit("changed");
  if (props.mode === "picker" && results.length) {
    const picked = results.map(result => result.file).filter(pickable).map(file => file.pathname);
    selected.value = props.multiple ? [...new Set([...selected.value, ...picked])] : picked.slice(-1);
  }
  return results;
}

function chooseFiles(event: Event): void {
  const input = event.target as HTMLInputElement;
  const files = [...input.files ?? []];
  input.value = "";
  void upload(files);
}

function hasFiles(event: DragEvent): boolean {
  return [...event.dataTransfer?.types ?? []].includes("Files");
}

function dragenter(event: DragEvent): void {
  if (!hasFiles(event) || !access.value.write) return;
  event.preventDefault();
  dragDepth.value++;
}

function dragover(event: DragEvent): void {
  if (!hasFiles(event) || !access.value.write) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function dragleave(event: DragEvent): void {
  if (!hasFiles(event)) return;
  dragDepth.value = Math.max(0, dragDepth.value - 1);
}

function drop(event: DragEvent): void {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth.value = 0;
  void upload([...event.dataTransfer?.files ?? []]);
}

// Folders

const folderOpen = ref(false);
const folderName = ref("");
const creatingFolder = ref(false);

async function createFolder(): Promise<void> {
  const name = folderName.value.trim();
  if (!name) return;
  creatingFolder.value = true;
  try {
    const { path } = await props.client.createFolder(folder.value, name);
    folderOpen.value = false;
    folderName.value = "";
    folders.value = [...new Set([...folders.value, path])].sort((left, right) => left.localeCompare(right));
    toast.show({ title: `Folder ${consoleFolderName(path)} created` });
  }
  catch (requestError) {
    toast.error(`Couldn't create the folder. ${consoleErrorMessage(requestError, "Try again.")}`);
  }
  finally {
    creatingFolder.value = false;
  }
}

// Moves

const moveDialog = ref<InstanceType<typeof ConsoleMediaMove>>();
const moveState = ref<{ files?: ConsoleMediaFile[], folder?: string, name?: string, title: string, warning?: string }>();
const moveOpen = ref(false);

function usageWarning(references: Record<string, ConsoleMediaReferenceDocument[]>, verb: string): string | undefined {
  const documents = new Map<string, ConsoleMediaReferenceDocument>();
  for (const list of Object.values(references)) for (const reference of list) documents.set(`${reference.collection}/${reference.id}`, reference);
  if (!documents.size) return undefined;
  const names = [...documents.values()].slice(0, 3).map(reference => reference.title).join(", ");
  const more = documents.size > 3 ? ` and ${documents.size - 3} more` : "";
  return `Used in ${documents.size === 1 ? "1 document" : `${documents.size} documents`}: ${names}${more}. ${verb} breaks their links until you pick the file again.`;
}

/** Each dialog opening gets a ticket, so a late usage check never updates a newer dialog. */
let ticket = 0;

async function askMove(files: ConsoleMediaFile[]): Promise<void> {
  if (!files.length) return;
  const current = ++ticket;
  const single = files.length === 1 ? files[0] : undefined;
  moveState.value = { files, title: single ? `Rename or move ${single.name}` : `Move ${files.length} files`, ...(single ? { name: single.name } : {}) };
  moveOpen.value = true;
  try {
    const warning = usageWarning(await props.client.usage(files.map(file => file.pathname)), "Moving");
    if (current === ticket && moveState.value && warning) moveState.value = { ...moveState.value, warning };
  }
  catch {
    // The move still works; the warning is a courtesy.
  }
}

function askMoveFolder(path: string): void {
  ticket++;
  moveState.value = { folder: path, name: consoleFolderName(path), title: `Rename or move ${consoleFolderName(path)}` };
  moveOpen.value = true;
}

async function confirmMove(destination: { folder: string, name?: string }): Promise<void> {
  const state = moveState.value;
  if (!state) return;
  const join = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);
  try {
    if (state.folder !== undefined) {
      const { path } = await props.client.moveFolder(state.folder, join(destination.folder, destination.name ?? consoleFolderName(state.folder)));
      toast.show({ title: `Folder moved to ${path}` });
    }
    else if (state.files) {
      const result = await props.client.move(state.files.map(file => ({ from: file.pathname, to: join(destination.folder, state.files!.length === 1 && destination.name ? destination.name : file.name) })));
      if (result.failed.length && !result.moved.length) throw new Error(result.failed[0]!.message);
      for (const file of result.moved) known.set(file.pathname, file);
      if (result.failed.length) toast.error(`${result.failed.length} of ${state.files.length} files couldn't move. ${result.failed[0]!.message}`);
      else toast.show({ title: result.moved.length === 1 ? `Moved to ${result.moved[0]!.pathname}` : `${result.moved.length} files moved` });
      if (props.active && state.files.some(file => file.pathname === props.active)) emit("open", result.moved.find(file => file.name === destination.name) ?? result.moved[0]);
    }
    moveOpen.value = false;
    selected.value = [];
    emit("changed");
    await load();
  }
  catch (requestError) {
    moveDialog.value?.failed(consoleErrorMessage(requestError, "The move failed."));
  }
}

// Deletes

const removeState = ref<{ files?: ConsoleMediaFile[], folder?: string, count?: number, warning?: string, checking: boolean }>();
const removeOpen = ref(false);
const removing = ref(false);

async function askRemove(files: ConsoleMediaFile[]): Promise<void> {
  if (!files.length) return;
  const current = ++ticket;
  removeState.value = { checking: true, files };
  removeOpen.value = true;
  try {
    const warning = usageWarning(await props.client.usage(files.map(file => file.pathname)), "Deleting");
    if (current === ticket && removeState.value) removeState.value = { ...removeState.value, checking: false, ...(warning ? { warning } : {}) };
  }
  catch {
    if (current === ticket && removeState.value) removeState.value = { ...removeState.value, checking: false, warning: "Couldn't check which documents use these files." };
  }
}

async function askRemoveFolder(path: string): Promise<void> {
  const current = ++ticket;
  removeState.value = { checking: true, folder: path };
  removeOpen.value = true;
  try {
    const listing = await props.client.list({ folder: path });
    const count = listing.items.length + listing.folders.length;
    if (current === ticket && removeState.value) removeState.value = { ...removeState.value, checking: false, count: listing.hasMore ? Number.POSITIVE_INFINITY : count };
  }
  catch {
    if (current === ticket && removeState.value) removeState.value = { ...removeState.value, checking: false };
  }
}

async function confirmRemove(): Promise<void> {
  const state = removeState.value;
  if (!state) return;
  removing.value = true;
  try {
    if (state.folder !== undefined) {
      const { removed } = await props.client.removeFolder(state.folder, true);
      toast.show({ title: removed ? `Folder and ${removed === 1 ? "1 file" : `${removed} files`} deleted` : "Folder deleted" });
    }
    else if (state.files) {
      const result = await props.client.remove(state.files.map(file => file.pathname));
      if (result.failed.length) toast.error(`${result.failed.length} of ${state.files.length} files couldn't be deleted. ${result.failed[0]!.message}`);
      else toast.show({ title: result.removed.length === 1 ? `${state.files[0]!.name} deleted` : `${result.removed.length} files deleted` });
      for (const pathname of result.removed) known.delete(pathname);
      items.value = items.value.filter(item => !result.removed.includes(item.pathname));
      selected.value = selected.value.filter(pathname => !result.removed.includes(pathname));
      if (props.active && result.removed.includes(props.active)) emit("open", undefined);
    }
    removeOpen.value = false;
    emit("changed");
    await load();
  }
  catch (requestError) {
    toast.error(`Couldn't delete. ${consoleErrorMessage(requestError, "Try again.")}`);
  }
  finally {
    removing.value = false;
  }
}

const removeTitle = computed(() => {
  const state = removeState.value;
  if (!state) return "Delete";
  if (state.folder !== undefined) return `Delete ${consoleFolderName(state.folder)}`;
  return state.files?.length === 1 ? `Delete ${state.files[0]!.name}` : `Delete ${state.files?.length ?? 0} files`;
});

/** Replace a file after the detail panel changed it. */
function replace(file: ConsoleMediaFile): void {
  known.set(file.pathname, file);
  items.value = items.value.map(item => (item.pathname === file.pathname ? file : item));
}

onBeforeUnmount(() => clearTimeout(searchTimer));

defineExpose({
  askMove,
  askRemove,
  /** A listed file by pathname, including ones listed in other folders. */
  file: (pathname: string) => known.get(pathname),
  /** The selected files, including ones listed in other folders. */
  files: selectedFiles,
  reload: () => load(),
  replace,
  upload,
});
</script>

<template>
  <div
    class="vitehub-media-browser relative flex min-h-0 flex-1 flex-col"
    @dragenter="dragenter"
    @dragover="dragover"
    @dragleave="dragleave"
    @drop="drop"
    @keydown="keydown"
  >
    <ConsolePageToolbar>
      <!-- On the Media page the header shows the folder trail; the picker shows it here. -->
      <nav v-if="mode === 'picker'" class="flex min-w-0 basis-full items-center gap-0.5 text-[13px] sm:basis-auto sm:flex-1" aria-label="Folders">
        <template v-for="(path, index) in trail" :key="path || '/'">
          <UIcon v-if="index" name="i-lucide-chevron-right" class="size-3.5 shrink-0 text-dimmed" aria-hidden="true" />
          <button
            type="button"
            class="vitehub-media-crumb"
            :aria-current="index === trail.length - 1 && !searching ? 'page' : undefined"
            @click="open(path)"
          >
            {{ folderLabel(path) }}
          </button>
        </template>
      </nav>
      <UInput v-model="search" class="w-full sm:w-56" icon="i-lucide-search" size="sm" :placeholder="searchPlaceholder ?? 'Search file names…'" :aria-label="searchPlaceholder ?? 'Search file names'" />
      <USelect v-model="type" class="w-32" size="sm" :items="typeItems" aria-label="Filter by type" />
      <!-- Controls of the page that hosts the browser, such as the Blob section's store picker. -->
      <slot name="toolbar" />
      <div class="ms-auto flex items-center gap-1.5">
        <div class="flex rounded-md ring-1 ring-(--ui-border) ring-inset" role="group" aria-label="View">
          <UTooltip text="Grid">
            <UButton size="sm" variant="ghost" icon="i-lucide-layout-grid" aria-label="Grid" :aria-pressed="view === 'grid'" :class="view === 'grid' ? 'bg-elevated text-highlighted' : 'text-dimmed'" @click="view = 'grid'" />
          </UTooltip>
          <UTooltip text="List">
            <UButton size="sm" variant="ghost" icon="i-lucide-list" aria-label="List" :aria-pressed="view === 'list'" :class="view === 'list' ? 'bg-elevated text-highlighted' : 'text-dimmed'" @click="view = 'list'" />
          </UTooltip>
        </div>
        <!-- The Media page moves its actions into the page header, next to the title, like New on a collection. -->
        <Teleport v-if="access.write" :to="actionsTarget ?? 'body'" :disabled="!actionsTarget">
          <UPopover v-model:open="folderOpen" :content="{ align: 'end' }">
            <UButton size="sm" variant="outline" icon="i-lucide-folder-plus" :label="actionsTarget ? 'New folder' : undefined" aria-label="New folder" />
            <template #content>
              <form class="grid w-64 gap-2 p-3" @submit.prevent="createFolder">
                <UInput v-model="folderName" size="sm" placeholder="Folder name" aria-label="Folder name" autofocus />
                <p class="text-xs text-dimmed">In {{ folderLabel(folder) }}</p>
                <div class="flex justify-end gap-2">
                  <UButton size="xs" variant="ghost" label="Cancel" @click="folderOpen = false" />
                  <UButton type="submit" size="xs" label="Create" :loading="creatingFolder" :disabled="!folderName.trim()" />
                </div>
              </form>
            </template>
          </UPopover>
          <UButton size="sm" icon="i-lucide-upload" label="Upload" @click="fileInput?.click()" />
        </Teleport>
        <input ref="fileInput" type="file" multiple class="hidden" :accept="mode === 'picker' && accept?.length ? accept.join(',') : undefined" aria-label="Files to upload" @change="chooseFiles">
      </div>
    </ConsolePageToolbar>

    <div class="min-h-0 flex-1 overflow-y-auto" :class="mode === 'page' ? 'p-4' : 'p-3'">
      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        icon="i-lucide-cloud-off"
        title="Couldn't load media"
        :description="consoleErrorMessage(error)"
        :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', color: 'neutral', variant: 'outline', onClick: () => load() }]"
      />
      <div v-else-if="loading && !items.length && !folders.length" class="vitehub-media-grid" aria-busy="true">
        <USkeleton v-for="index in 12" :key="index" class="aspect-square rounded-md" />
      </div>
      <template v-else>
        <p v-if="searching" class="mb-3 text-xs text-muted">
          {{ items.length ? `${items.length} ${items.length === 1 ? "file" : "files"} in ${folderLabel(folder)} and its folders` : `No file names match “${query}”` }}{{ truncated ? ". Search stopped early; open a folder to narrow it." : "" }}
        </p>

        <div v-if="!searching && folders.length" class="vitehub-media-folders mb-4" :class="view === 'list' ? 'is-list' : ''">
          <div v-for="path in folders" :key="path" class="vitehub-media-folder group">
            <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-start" @click="open(path)">
              <UIcon name="i-lucide-folder" class="size-4 shrink-0 text-muted" aria-hidden="true" />
              <span class="truncate">{{ consoleFolderName(path) }}</span>
            </button>
            <UDropdownMenu
              v-if="mode === 'page' && access.manage"
              :content="{ align: 'end' }"
              :items="[[{ label: 'Rename or move…', icon: 'i-lucide-pencil', onSelect: () => askMoveFolder(path) }], [{ label: 'Delete folder', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => askRemoveFolder(path) }]]"
            >
              <UButton variant="ghost" size="xs" icon="i-lucide-ellipsis" class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100" :aria-label="`Actions for folder ${consoleFolderName(path)}`" />
            </UDropdownMenu>
          </div>
        </div>

        <UEmpty
          v-if="!items.length && !searching && !folders.length"
          variant="naked"
          class="py-16"
          :icon="folder ? 'i-lucide-folder-open' : 'i-lucide-images'"
          :title="folder ? 'This folder is empty' : 'No media yet'"
          :description="emptyDescription ?? (access.write ? 'Drop files anywhere here, or upload them.' : 'Files that editors upload show here.')"
          :actions="access.write ? [{ label: 'Upload files', icon: 'i-lucide-upload', color: 'neutral', variant: 'outline', onClick: () => fileInput?.click() }] : []"
        />

        <ul v-else-if="view === 'grid' && items.length" class="vitehub-media-grid" :aria-label="`Files in ${folderLabel(folder)}`" :aria-multiselectable="canSelect ? 'true' : undefined" role="listbox">
          <li
            v-for="file in items"
            :key="file.pathname"
            role="option"
            :aria-selected="selectedSet.has(file.pathname) || active === file.pathname"
            :aria-disabled="!pickable(file) || undefined"
            class="vitehub-media-tile group"
            :class="{ 'is-selected': selectedSet.has(file.pathname), 'is-active': active === file.pathname, 'is-disabled': !pickable(file) }"
          >
            <button
              type="button"
              class="vitehub-media-tile__button"
              :title="file.pathname"
              :disabled="!pickable(file)"
              @click="click(file, $event)"
              @dblclick="activate(file)"
              @keydown.enter.prevent="mode === 'picker' ? activate(file) : click(file, $event as unknown as MouseEvent)"
            >
              <span class="vitehub-media-tile__thumb" :style="{ background: file.color }">
                <img v-if="thumbnail(file)" :src="thumbnail(file)" :alt="file.alt ?? ''" loading="lazy" decoding="async" class="vitehub-media-tile__image" :style="{ objectPosition: consoleFocalCropPosition(file.focal, file, 1) }" @load="loaded">
                <span v-else class="flex size-full flex-col items-center justify-center gap-1 text-dimmed">
                  <UIcon :name="consoleMediaTypeIcons[consoleMediaType(file.contentType)]" class="size-6" aria-hidden="true" />
                  <span class="text-[11px] font-medium">{{ consoleMediaFormat(file) }}</span>
                </span>
              </span>
              <span class="grid min-w-0 gap-0.5 px-0.5 pt-2">
                <span class="truncate text-[13px] text-highlighted">{{ file.name }}</span>
                <span class="truncate text-xs text-dimmed tabular-nums">{{ searching ? file.pathname : meta(file) }}</span>
              </span>
            </button>
            <UCheckbox color="neutral"
              v-if="canSelect"
              class="vitehub-media-tile__check"
              :model-value="selectedSet.has(file.pathname)"
              :disabled="!pickable(file)"
              :aria-label="`Select ${file.name}`"
              @update:model-value="toggle(file)"
            />
          </li>
        </ul>

        <table v-else-if="items.length" class="vitehub-media-table w-full text-[13px]">
          <thead>
            <tr>
              <th v-if="canSelect" class="w-8"><span class="sr-only">Selected</span></th>
              <th class="text-start">Name</th>
              <th class="hidden text-start sm:table-cell">Type</th>
              <th class="hidden text-end sm:table-cell">Size</th>
              <th v-if="hasDimensions" class="hidden text-end md:table-cell">Dimensions</th>
              <th class="hidden text-end lg:table-cell">Uploaded</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="file in items"
              :key="file.pathname"
              :class="{ 'is-selected': selectedSet.has(file.pathname), 'is-active': active === file.pathname, 'is-disabled': !pickable(file) }"
              @click="pickable(file) && click(file, $event)"
              @dblclick="activate(file)"
            >
              <td v-if="canSelect" @click.stop>
                <UCheckbox color="neutral" :model-value="selectedSet.has(file.pathname)" :disabled="!pickable(file)" :aria-label="`Select ${file.name}`" @update:model-value="toggle(file)" />
              </td>
              <td>
                <button type="button" class="flex min-w-0 items-center gap-2.5 text-start" :disabled="!pickable(file)" @click.stop="click(file, $event)" @keydown.enter.prevent="mode === 'picker' ? activate(file) : click(file, $event as unknown as MouseEvent)">
                  <span class="vitehub-media-row-thumb" :style="{ background: file.color }">
                    <img v-if="thumbnail(file, 64)" :src="thumbnail(file, 64)" alt="" loading="lazy" class="size-full object-cover" :style="{ objectPosition: consoleFocalCropPosition(file.focal, file, 1) }">
                    <UIcon v-else :name="consoleMediaTypeIcons[consoleMediaType(file.contentType)]" class="size-4 text-dimmed" aria-hidden="true" />
                  </span>
                  <span class="grid min-w-0">
                    <span class="truncate text-highlighted">{{ file.name }}</span>
                    <span v-if="searching" class="truncate font-mono text-xs text-dimmed">{{ file.pathname }}</span>
                  </span>
                </button>
              </td>
              <td class="hidden text-muted sm:table-cell">{{ consoleMediaFormat(file) }}</td>
              <td class="hidden text-end text-muted tabular-nums sm:table-cell">{{ consoleBytes(file.size) }}</td>
              <td v-if="hasDimensions" class="hidden text-end text-muted tabular-nums md:table-cell">{{ file.width && file.height ? `${file.width} × ${file.height}` : "—" }}</td>
              <td class="hidden text-end text-muted lg:table-cell"><ConsoleRelativeTime :value="file.createdAt" /></td>
            </tr>
          </tbody>
        </table>

        <div v-if="cursor && !searching" class="mt-4 flex justify-center">
          <UButton variant="outline" size="sm" label="Load more" :loading="loadingMore" @click="load({ more: true })" />
        </div>
      </template>
    </div>

    <div v-if="mode === 'page' && selecting" class="vitehub-media-bulk" role="toolbar" aria-label="Selected files">
      <span class="ps-1 text-[13px] text-highlighted tabular-nums">{{ selected.length }} selected</span>
      <span class="h-4 w-px bg-(--ui-border)" aria-hidden="true" />
      <UButton v-if="access.manage" size="sm" variant="ghost" icon="i-lucide-folder-input" label="Move…" @click="askMove(selectedFiles())" />
      <UButton v-if="access.manage" size="sm" variant="ghost" color="error" icon="i-lucide-trash-2" label="Delete" @click="askRemove(selectedFiles())" />
      <UTooltip text="Clear selection" :kbds="['esc']">
        <UButton size="sm" variant="ghost" icon="i-lucide-x" aria-label="Clear selection" @click="selected = []" />
      </UTooltip>
    </div>

    <div v-if="dragDepth > 0" class="vitehub-media-drop" aria-hidden="true">
      <div class="flex flex-col items-center gap-2 text-center">
        <UIcon name="i-lucide-upload" class="size-6 text-highlighted" />
        <p class="text-sm font-medium text-highlighted">Drop to upload to {{ folderLabel(folder) }}</p>
      </div>
    </div>

    <ConsoleMediaUploads :uploads="uploads" />

    <ConsoleMediaMove
      v-if="moveState"
      ref="moveDialog"
      v-model:open="moveOpen"
      :client="client"
      :folder="moveState.folder !== undefined ? moveState.folder.slice(0, Math.max(0, moveState.folder.lastIndexOf('/'))) : folder"
      :moving="moveState.folder"
      :name="moveState.name"
      :title="moveState.title"
      :warning="moveState.warning"
      @confirm="confirmMove"
    />

    <UModal v-model:open="removeOpen" :title="removeTitle" :ui="{ content: 'sm:max-w-[440px]' }">
      <template #body>
        <div class="grid gap-3 text-[13px] text-muted">
          <template v-if="removeState?.folder !== undefined">
            <p v-if="removeState.checking">Checking the folder…</p>
            <p v-else-if="removeState.count">Everything inside it is deleted too: files, their crops, and their variants. This cannot be undone.</p>
            <p v-else>The folder is empty.</p>
          </template>
          <template v-else>
            <p>The {{ removeState?.files?.length === 1 ? "file" : "files" }}, {{ removeState?.files?.length === 1 ? "its" : "their" }} crops, and {{ removeState?.files?.length === 1 ? "its" : "their" }} variants are deleted. This cannot be undone.</p>
            <USkeleton v-if="removeState?.checking" class="h-9 w-full" />
            <p v-else-if="removeState?.warning" class="flex gap-2 rounded-md bg-elevated/60 px-3 py-2 text-xs">
              <UIcon name="i-lucide-triangle-alert" class="mt-px size-3.5 shrink-0 text-warning" aria-hidden="true" />
              <span>{{ removeState.warning }}</span>
            </p>
          </template>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" label="Cancel" @click="removeOpen = false" />
          <UButton color="error" label="Delete" :loading="removing" :disabled="removeState?.checking" @click="confirmRemove" />
        </div>
      </template>
    </UModal>
  </div>
</template>

<style>
/* The detail panel of a file sits next to the browser on wide screens and covers it on narrow ones. */
.vitehub-media-library__detail {
  border-left: 1px solid var(--ui-border);
  flex-shrink: 0;
  width: 22.5rem;
}

@media (max-width: 1023px) {
  .vitehub-media-library__detail {
    background: var(--ui-bg);
    border-left: 0;
    inset: 0;
    position: absolute;
    width: auto;
    z-index: 40;
  }
}

.vitehub-media-crumb {
  border-radius: 0.375rem;
  color: var(--ui-text-muted);
  max-width: 12rem;
  overflow: hidden;
  padding: 0.125rem 0.375rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vitehub-media-crumb:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}

.vitehub-media-crumb[aria-current="page"] {
  color: var(--ui-text-highlighted);
  font-weight: 500;
}

.vitehub-media-crumb:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: -2px;
}

.vitehub-media-grid {
  display: grid;
  gap: 1rem 0.75rem;
  grid-template-columns: repeat(auto-fill, minmax(min(8rem, 100%), 1fr));
}

@media (min-width: 640px) {
  .vitehub-media-grid {
    grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
  }
}

.vitehub-media-folders {
  display: grid;
  gap: 0.5rem;
  grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
}

.vitehub-media-folders.is-list {
  gap: 1px;
  grid-template-columns: 1fr;
}

.vitehub-media-folder {
  align-items: center;
  border: 1px solid var(--ui-border);
  border-radius: 0.375rem;
  color: var(--ui-text-highlighted);
  display: flex;
  font-size: 0.8125rem;
  gap: 0.25rem;
  height: 2.5rem;
  padding-inline: 0.75rem 0.25rem;
}

.vitehub-media-folders.is-list .vitehub-media-folder {
  border-color: transparent;
  height: 2.25rem;
  padding-inline: 0.5rem 0.25rem;
}

.vitehub-media-folder:hover {
  background: var(--ui-bg-elevated);
}

.vitehub-media-tile {
  min-width: 0;
  position: relative;
}

.vitehub-media-tile__button {
  display: grid;
  min-width: 0;
  text-align: start;
  width: 100%;
}

.vitehub-media-tile__button:focus-visible {
  outline: none;
}

.vitehub-media-tile__button:focus-visible .vitehub-media-tile__thumb {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

/* An inset hairline keeps light images apart from the page (Rauno: image outlines). */
.vitehub-media-tile__thumb {
  aspect-ratio: 1;
  background: var(--ui-bg-elevated);
  border-radius: 0.375rem;
  display: block;
  overflow: hidden;
  position: relative;
}

.vitehub-media-tile__thumb::after {
  border-radius: inherit;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.08);
  content: "";
  inset: 0;
  pointer-events: none;
  position: absolute;
}

.dark .vitehub-media-tile__thumb::after {
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.08);
}

.vitehub-media-tile__image {
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity 150ms ease-out;
  width: 100%;
}

.vitehub-media-tile__image[data-loaded] {
  opacity: 1;
}

.vitehub-media-tile.is-selected .vitehub-media-tile__thumb,
.vitehub-media-tile.is-active .vitehub-media-tile__thumb {
  outline: 2px solid var(--ui-border-inverted);
  outline-offset: 2px;
}

.vitehub-media-tile.is-disabled {
  opacity: 0.45;
}

.vitehub-media-tile__check {
  left: 0.5rem;
  opacity: 0;
  position: absolute;
  top: 0.5rem;
}

.vitehub-media-tile:hover .vitehub-media-tile__check,
.vitehub-media-tile.is-selected .vitehub-media-tile__check,
.vitehub-media-tile__check:focus-within,
.vitehub-media-grid:has(.is-selected) .vitehub-media-tile__check {
  opacity: 1;
}

.vitehub-media-table th {
  border-bottom: 1px solid var(--ui-border);
  color: var(--ui-text-dimmed);
  font-size: 0.75rem;
  font-weight: 500;
  height: 2rem;
  padding-inline: 0.5rem;
}

.vitehub-media-table td {
  border-bottom: 1px solid var(--ui-border);
  height: 2.75rem;
  padding-inline: 0.5rem;
}

.vitehub-media-table tbody tr:hover {
  background: var(--ui-bg-elevated);
}

.vitehub-media-table tbody tr.is-selected,
.vitehub-media-table tbody tr.is-active {
  background: var(--ui-bg-accented);
}

.vitehub-media-table tbody tr.is-disabled {
  opacity: 0.45;
}

.vitehub-media-row-thumb {
  align-items: center;
  background: var(--ui-bg-elevated);
  border-radius: 0.25rem;
  display: inline-flex;
  flex-shrink: 0;
  height: 1.75rem;
  justify-content: center;
  overflow: hidden;
  width: 1.75rem;
}

/* Floating bars use the Geist menu material: a 12px radius, a hairline ring, and a layered shadow. */
.vitehub-media-bulk {
  align-items: center;
  background: var(--ui-bg);
  border-radius: 0.75rem;
  bottom: 1rem;
  box-shadow: 0 0 0 1px var(--ui-border), 0 1px 1px rgb(0 0 0 / 2%), 0 4px 8px -4px rgb(0 0 0 / 4%), 0 16px 24px -8px rgb(0 0 0 / 8%);
  display: flex;
  gap: 0.25rem;
  left: 50%;
  padding: 0.25rem 0.25rem 0.25rem 0.5rem;
  position: absolute;
  transform: translateX(-50%);
  z-index: 15;
}

/* The drop target covers the whole browser, so a file can land anywhere on it. */
.vitehub-media-drop {
  align-items: center;
  background: color-mix(in oklab, var(--ui-bg) 85%, transparent);
  border: 1.5px dashed var(--ui-border-inverted);
  border-radius: 0.5rem;
  display: flex;
  inset: 0.5rem;
  justify-content: center;
  pointer-events: none;
  position: absolute;
  z-index: 30;
}
</style>
