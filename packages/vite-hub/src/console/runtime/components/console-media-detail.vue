<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";

import { consoleErrorMessage } from "../client/documents";
import { consoleBytes, consoleMediaDate, consoleMediaFormat, consoleMediaTransformable, consoleMediaType, consoleMediaTypeIcons, consoleMediaUrl, consoleMediaVariantUrl } from "../client/media-library";
import { useConsoleToast } from "../client/toast";
import { resolveConsoleRouteName } from "../console-route";
import { consoleSectionRouteName } from "../sections";
import ConsoleMediaCrops from "./console-media-crops.vue";
import ConsoleMediaFocal from "./console-media-focal.vue";

import type { ConsoleMediaAccess, ConsoleMediaClient, ConsoleMediaFile, ConsoleMediaFocal as ConsoleMediaFocalPoint, ConsoleMediaReferenceDocument } from "../client/media-library";

/**
 * The details of one file: a preview, alt text and caption that save as you type, size and format, the served URL,
 * the focal point, named crops with replacements, and the documents that use the file.
 */
const props = defineProps<{
  access: ConsoleMediaAccess;
  client: ConsoleMediaClient;
  file: ConsoleMediaFile;
  section: string;
  served: string | null;
}>();

const emit = defineEmits<{
  close: [];
  /** Asks the library to delete the file, after it warns about the documents that use it. */
  remove: [file: ConsoleMediaFile];
  rename: [file: ConsoleMediaFile];
  updated: [file: ConsoleMediaFile];
}>();

const route = useRoute();
const toast = useConsoleToast();
const url = computed(() => props.file.url ?? consoleMediaUrl(props.served, props.file.pathname));
const type = computed(() => consoleMediaType(props.file.contentType));
const isImage = computed(() => type.value === "image");
const preview = computed(() => {
  if (!url.value || !isImage.value) return undefined;
  return consoleMediaTransformable(props.file.contentType) ? consoleMediaVariantUrl(url.value, { version: props.file.updatedAt, width: 1080 }) : url.value;
});
const absoluteUrl = computed(() => (url.value ? new URL(url.value, globalThis.location?.href ?? "http://localhost").href : undefined));

// Alt text and caption save 600 ms after typing stops, and at once when focus leaves the field.
const alt = ref(props.file.alt ?? "");
const caption = ref(props.file.caption ?? "");
const saving = ref(false);
const saved = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let pending: Promise<void> | undefined;

watch(() => props.file.pathname, () => {
  void flush();
  alt.value = props.file.alt ?? "";
  caption.value = props.file.caption ?? "";
  saved.value = false;
  void loadUsage();
});

function dirty(): boolean {
  return alt.value.trim() !== (props.file.alt ?? "") || caption.value.trim() !== (props.file.caption ?? "");
}

async function save(): Promise<void> {
  clearTimeout(timer);
  if (!dirty() || !props.access.write) return;
  const pathname = props.file.pathname;
  const patch = { alt: alt.value.trim() || null, caption: caption.value.trim() || null };
  saving.value = true;
  try {
    const next = await props.client.update(pathname, patch);
    saved.value = true;
    if (next.pathname === props.file.pathname) emit("updated", next);
  }
  catch (error) {
    toast.error(`Couldn't save the details. ${consoleErrorMessage(error, "Try again.")}`);
  }
  finally {
    saving.value = false;
  }
}

function schedule(): void {
  saved.value = false;
  clearTimeout(timer);
  timer = setTimeout(() => void flush(), 600);
}

async function flush(): Promise<void> {
  await pending;
  pending = save();
  await pending;
}

onBeforeUnmount(() => void flush());

async function setFocal(focal: ConsoleMediaFocalPoint | undefined): Promise<void> {
  try {
    emit("updated", await props.client.update(props.file.pathname, { focal: focal ?? null }));
  }
  catch (error) {
    toast.error(`Couldn't save the focal point. ${consoleErrorMessage(error, "Try again.")}`);
  }
}

async function copy(value: string | undefined, label: string): Promise<void> {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    toast.show({ title: `${label} copied` });
  }
  catch {
    toast.error(`Couldn't copy the ${label.toLowerCase()}.`);
  }
}

// "Used in": the draft and published documents that reference the file.
const usage = ref<ConsoleMediaReferenceDocument[]>();
const usageError = ref<unknown>();
let usageRequest = 0;
async function loadUsage(): Promise<void> {
  const current = ++usageRequest;
  usage.value = undefined;
  usageError.value = undefined;
  try {
    const references = await props.client.usage([props.file.pathname]);
    if (current === usageRequest) usage.value = references[props.file.pathname] ?? [];
  }
  catch (error) {
    if (current === usageRequest) usageError.value = error;
  }
}
void loadUsage();

function documentRoute(reference: ConsoleMediaReferenceDocument) {
  return { name: resolveConsoleRouteName(route.name, consoleSectionRouteName(props.section)), params: { collection: reference.collection, document: reference.id.split("/") } };
}

const facts = computed(() => [
  ...(props.file.width && props.file.height ? [{ label: "Dimensions", value: `${props.file.width} × ${props.file.height}` }] : []),
  { label: "Size", value: consoleBytes(props.file.size) },
  { label: "Format", value: consoleMediaFormat(props.file) },
  { label: "Uploaded", value: consoleMediaDate(props.file.createdAt) },
]);
</script>

<template>
  <aside class="vitehub-media-detail flex min-h-0 flex-col border-default bg-default" :aria-label="`Details of ${file.name}`">
    <header class="flex h-(--ui-header-height) shrink-0 items-center gap-2 border-b border-default px-4">
      <h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-highlighted" :title="file.pathname">{{ file.name }}</h2>
      <UDropdownMenu
        :content="{ align: 'end' }"
        :items="[
          [
            { label: 'Copy URL', icon: 'i-lucide-link', disabled: !absoluteUrl, onSelect: () => copy(absoluteUrl, 'URL') },
            { label: 'Copy pathname', icon: 'i-lucide-copy', onSelect: () => copy(file.pathname, 'Pathname') },
            ...(url ? [{ label: 'Open original', icon: 'i-lucide-arrow-up-right', to: url, target: '_blank' }] : []),
          ],
          ...(access.manage ? [[
            { label: 'Rename or move…', icon: 'i-lucide-pencil', onSelect: () => emit('rename', file) },
            { label: 'Delete', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => emit('remove', file) },
          ]] : []),
        ]"
      >
        <UButton variant="ghost" size="sm" icon="i-lucide-ellipsis" aria-label="File actions" />
      </UDropdownMenu>
      <UButton variant="ghost" size="sm" icon="i-lucide-x" aria-label="Close details" @click="emit('close')" />
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <section class="grid gap-3 p-4">
        <ConsoleMediaFocal
          v-if="preview"
          :model-value="file.focal"
          :src="preview"
          :alt="file.alt"
          :color="file.color"
          :width="file.width"
          :height="file.height"
          :disabled="!access.write"
          @update:model-value="setFocal"
        />
        <div v-else class="flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-md bg-elevated text-dimmed">
          <UIcon :name="consoleMediaTypeIcons[type]" class="size-8" aria-hidden="true" />
          <span class="text-xs">{{ url ? consoleMediaFormat(file) : "Not served. Enable blob.serve to preview files." }}</span>
        </div>
        <p v-if="preview" class="text-xs text-muted">
          {{ access.write ? "Click or drag to set the focal point. Crops and variants keep it in frame." : "Crops and variants keep the focal point in frame." }}
        </p>
      </section>

      <section class="grid gap-3 border-t border-default p-4" aria-labelledby="media-detail-text">
        <div class="flex items-center justify-between">
          <h3 id="media-detail-text" class="text-xs font-medium text-highlighted">Description</h3>
          <span class="text-xs text-dimmed" aria-live="polite">{{ saving ? "Saving…" : saved ? "Saved" : "" }}</span>
        </div>
        <UFormField label="Alt text" :description="isImage ? 'What the image shows, for people who cannot see it.' : undefined" :ui="{ label: 'text-xs', description: 'text-xs' }">
          <UTextarea
            v-model="alt"
            class="w-full"
            autoresize
            :rows="2"
            :maxrows="6"
            :disabled="!access.write"
            placeholder="A laptop on a desk, with the editor open"
            @update:model-value="schedule"
            @blur="flush"
          />
        </UFormField>
        <UFormField label="Caption" :ui="{ label: 'text-xs' }">
          <UTextarea
            v-model="caption"
            class="w-full"
            autoresize
            :rows="1"
            :maxrows="6"
            :disabled="!access.write"
            placeholder="Shown under the image where the site uses captions"
            @update:model-value="schedule"
            @blur="flush"
          />
        </UFormField>
      </section>

      <section class="grid gap-3 border-t border-default p-4" aria-label="File information">
        <dl class="grid grid-cols-2 gap-x-4 gap-y-2">
          <div v-for="fact in facts" :key="fact.label" class="grid gap-0.5">
            <dt class="text-xs text-dimmed">{{ fact.label }}</dt>
            <dd class="text-[13px] text-highlighted tabular-nums">{{ fact.value }}</dd>
          </div>
        </dl>
        <div class="grid gap-1">
          <span class="text-xs text-dimmed">Pathname</span>
          <div class="flex min-w-0 items-center gap-1 rounded-md bg-elevated/60 py-1 ps-2 pe-1">
            <code class="min-w-0 flex-1 truncate text-xs" :title="file.pathname">{{ file.pathname }}</code>
            <UButton variant="ghost" size="xs" icon="i-lucide-copy" aria-label="Copy pathname" @click="copy(file.pathname, 'Pathname')" />
          </div>
        </div>
        <div v-if="absoluteUrl" class="grid gap-1">
          <span class="text-xs text-dimmed">URL</span>
          <div class="flex min-w-0 items-center gap-1 rounded-md bg-elevated/60 py-1 ps-2 pe-1">
            <code class="min-w-0 flex-1 truncate text-xs" :title="absoluteUrl">{{ url }}</code>
            <UButton variant="ghost" size="xs" icon="i-lucide-copy" aria-label="Copy URL" @click="copy(absoluteUrl, 'URL')" />
          </div>
        </div>
      </section>

      <section v-if="isImage && url && consoleMediaTransformable(file.contentType)" class="grid gap-3 border-t border-default p-4" aria-labelledby="media-detail-crops">
        <div class="grid gap-0.5">
          <h3 id="media-detail-crops" class="text-xs font-medium text-highlighted">Crops</h3>
          <p class="text-xs text-muted">Framing for other layouts. Upload a replacement when a phone needs a different image.</p>
        </div>
        <ConsoleMediaCrops :client="client" :file="file" :served="served" :disabled="!access.write" @updated="emit('updated', $event)" />
      </section>

      <section class="grid gap-2 border-t border-default p-4" aria-labelledby="media-detail-usage">
        <h3 id="media-detail-usage" class="text-xs font-medium text-highlighted">Used in</h3>
        <div v-if="usageError" class="flex items-center gap-2 text-xs text-muted">
          <span class="min-w-0 flex-1">Couldn't find the documents that use this file.</span>
          <UButton variant="ghost" size="xs" label="Try again" @click="loadUsage" />
        </div>
        <USkeleton v-else-if="!usage" class="h-7 w-2/3" />
        <p v-else-if="!usage.length" class="text-xs text-muted">No document uses this file.</p>
        <ul v-else class="grid gap-px">
          <li v-for="reference in usage" :key="`${reference.collection}/${reference.id}`">
            <RouterLink
              :to="documentRoute(reference)"
              class="flex h-8 items-center gap-2 rounded-md px-2 text-[13px] hover:bg-elevated focus-visible:outline-2"
            >
              <UIcon name="i-lucide-file-text" class="size-4 shrink-0 text-dimmed" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate text-highlighted">{{ reference.title }}</span>
              <span class="shrink-0 text-xs text-dimmed">{{ reference.refs.includes("published") ? (reference.refs.includes("draft") ? "Published" : "Published only") : "Draft" }}</span>
            </RouterLink>
          </li>
        </ul>
      </section>
    </div>
  </aside>
</template>
