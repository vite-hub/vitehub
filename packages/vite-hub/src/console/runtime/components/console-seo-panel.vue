<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

import { consoleImageUrl, consoleTruncate } from "../client/documents"
import { describeConsoleSchemaFields } from "../client/schema-form";
import { useConsoleMediaPicker } from "../client/media";
import ConsolePropertyRow from "./console-property-row.vue";
import ConsoleSchemaField from "./console-schema-field.vue";

import type { ConsoleSeoFallbacks, ConsoleSeoHint } from "../client/documents";

/**
 * Edits a `seo()` field as a group of property rows under the document fields: title and description with character
 * counters, the social image, the canonical URL, and noindex. Empty inputs show what `contentHead()` falls back to as
 * placeholders, and the previews show the result in a search listing and on a social card. The group folds while the
 * field is empty and opens on its own when one of its values has an issue.
 */
const props = defineProps<{
  disabled?: boolean;
  /** Server issues keyed by dotted field path, such as `seo.title`. */
  errors: Readonly<Record<string, string[]>>;
  fallbacks: ConsoleSeoFallbacks;
  hint: ConsoleSeoHint;
  /** Name of the `seo()` field, such as `seo`. */
  name: string;
  /** JSON Schema of the `seo()` field. */
  schema: Record<string, unknown>;
}>();

const model = defineModel<Record<string, unknown> | undefined>();

function record(value: unknown): Record<string, unknown> {
  return value instanceof Object && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

function text(value: unknown): string {
  return String(value) === value ? value : "";
}

const values = computed(() => record(model.value));
const hasIssue = computed(() => Object.keys(props.errors).some(path => path === props.name || path.startsWith(`${props.name}.`)));
const open = ref(Object.keys(values.value).length > 0 || hasIssue.value);
watch(hasIssue, (value) => {
  if (value) open.value = true;
});

function update(key: string, value: unknown): void {
  const next = { ...values.value };
  if (value === undefined || value === "" || value === false) delete next[key];
  else next[key] = value;
  // An SEO field without values is absent, so it falls back to the document entirely.
  model.value = Object.keys(next).length ? next : undefined;
}

const controlId = (key: string) => `field-${props.name}-${key}`;
const imageField = computed(() => describeConsoleSchemaFields(props.schema).find(field => field.name === "image"));
const host = computed(() => globalThis.location?.host || "example.com");
const title = computed(() => text(values.value.title).trim() || props.fallbacks.title || "");
const description = computed(() => text(values.value.description).trim() || props.fallbacks.description || "");
const path = computed(() => text(values.value.canonical) || props.fallbacks.url || "/");
const breadcrumb = computed(() => {
  const url = /^https?:\/\//i.test(path.value) ? new URL(path.value) : undefined;
  const segments = (url ? url.pathname : path.value).split("/").filter(Boolean);
  return [url?.host ?? host.value, ...segments].join(" › ");
});
// The media library knows the served URL of a Blob reference; without it, the default serve route is assumed.
const picker = useConsoleMediaPicker();
const imageUrl = computed(() => {
  const image = values.value.image ?? props.fallbacks.image;
  const pathname = record(image).pathname;
  const served = String(pathname) === pathname ? picker?.resolveSrc?.(pathname) : undefined;
  return served ?? consoleImageUrl(image);
});
const imageFailed = ref(false);
watch(imageUrl, () => {
  imageFailed.value = false;
});
const noindex = computed(() => values.value.noindex === true);
const summary = computed(() => {
  if (noindex.value) return "Hidden from search engines";
  const set = ["title", "description", "image", "canonical"].filter(key => values.value[key] !== undefined && values.value[key] !== "");
  return set.length ? `${set.length} of 4 set` : "From the document";
});

function error(key: string): string | undefined {
  const messages = Object.entries(props.errors)
    .filter(([path]) => path === `${props.name}.${key}` || path.startsWith(`${props.name}.${key}.`))
    .flatMap(([, entries]) => entries);
  return messages.length ? messages.join(" ") : undefined;
}

const titleCount = computed(() => text(values.value.title).length);
const descriptionCount = computed(() => text(values.value.description).length);
const titleLong = computed(() => titleCount.value > props.hint.title.recommended);
const descriptionOff = computed(() => descriptionCount.value > props.hint.description.recommended || (descriptionCount.value > 0 && descriptionCount.value < props.hint.description.min));

// Autoresize measures the value, not the placeholder. An empty description gets as many rows as its fallback needs at
// the current width, so the placeholder is never cut off.
const descriptionBox = ref<HTMLElement>();
const descriptionWidth = ref(0);
const descriptionFont = ref(14);
const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(([entry]) => {
  descriptionWidth.value = entry?.contentRect.width ?? 0;
  const textarea = descriptionBox.value?.querySelector("textarea");
  if (textarea) descriptionFont.value = Number.parseFloat(getComputedStyle(textarea).fontSize) || 14;
});
watch(descriptionBox, (element, previous) => {
  if (previous) observer?.unobserve(previous);
  if (element) observer?.observe(element);
});
onBeforeUnmount(() => observer?.disconnect());
const placeholderRows = computed(() => {
  const fallback = props.fallbacks.description || "Search engines pick text from the page";
  if (text(values.value.description) || !fallback || !descriptionWidth.value) return 1;
  // Geist averages a little over half its size per character. The padding and the counter take about 84px.
  const perRow = Math.max(12, Math.floor((descriptionWidth.value - 84) / (descriptionFont.value * 0.54)));
  return Math.min(6, Math.ceil(fallback.length / perRow));
});
</script>

<template>
  <section class="mt-1 grid gap-px" :aria-label="`${name} settings`">
    <UButton
      variant="ghost"
      class="w-fit max-w-full"
      :icon="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
      :aria-expanded="open"
      :aria-controls="`${controlId('group')}`"
      @click="open = !open"
    >
      <span class="text-highlighted">SEO</span>
      <span class="truncate text-dimmed">{{ summary }}</span>
      <span v-if="hasIssue && !open" class="size-1.5 shrink-0 rounded-full bg-error" aria-hidden="true" />
    </UButton>

    <div v-show="open" :id="controlId('group')" class="grid gap-px">
      <ConsolePropertyRow icon="i-lucide-heading" label="Title" :control="controlId('title')" :error="error('title')">
        <UInput
          :id="controlId('title')"
          :model-value="text(values.title)"
          class="w-full"
          variant="ghost"
          :highlight="Boolean(error('title'))"
          :color="error('title') ? 'error' : undefined"
          :disabled="disabled"
          :placeholder="fallbacks.title"
          :aria-invalid="error('title') ? 'true' : undefined"
          :aria-describedby="`${controlId('title')}-count`"
          @update:model-value="update('title', String($event ?? ''))"
        >
          <template #trailing>
            <span :id="`${controlId('title')}-count`" class="text-xs tabular-nums" :class="titleLong ? 'text-warning' : 'text-dimmed'">
              {{ titleCount }}/{{ hint.title.recommended }}<span class="sr-only"> characters{{ titleLong ? ", longer than search results show" : "" }}</span>
            </span>
          </template>
        </UInput>
      </ConsolePropertyRow>

      <ConsolePropertyRow icon="i-lucide-align-left" label="Description" :control="controlId('description')" :error="error('description')">
        <!-- The counter sits where the title's does, so both counts line up in one column. -->
        <div ref="descriptionBox" class="relative">
          <UTextarea
            :id="controlId('description')"
            :model-value="text(values.description)"
            class="w-full"
            variant="ghost"
            autoresize
            :rows="placeholderRows"
            :ui="{ base: 'pe-16' }"
            :highlight="Boolean(error('description'))"
            :color="error('description') ? 'error' : undefined"
            :disabled="disabled"
            :placeholder="fallbacks.description || 'Search engines pick text from the page'"
            :aria-invalid="error('description') ? 'true' : undefined"
            :aria-describedby="`${controlId('description')}-count`"
            @update:model-value="update('description', String($event ?? ''))"
          />
          <span :id="`${controlId('description')}-count`" class="pointer-events-none absolute top-2 right-2.5 text-xs tabular-nums" :class="descriptionOff ? 'text-warning' : 'text-dimmed'">
            {{ descriptionCount }}/{{ hint.description.recommended }}<span class="sr-only"> characters{{ descriptionOff ? `, recommended ${hint.description.min} to ${hint.description.recommended}` : "" }}</span>
          </span>
        </div>
      </ConsolePropertyRow>

      <ConsoleSchemaField
        v-if="imageField && imageField.kind !== 'string'"
        :disabled="disabled"
        :errors="errors"
        :field="{ ...imageField, label: 'Social image' }"
        :model-value="values.image"
        :parent="name"
        @update:model-value="update('image', $event)"
      />
      <ConsolePropertyRow v-else icon="i-lucide-image" label="Social image" :control="controlId('image')" :error="error('image')">
        <UInput
          :id="controlId('image')"
          :model-value="text(values.image)"
          class="w-full"
          variant="ghost"
          :disabled="disabled"
          placeholder="/og/page.png"
          @update:model-value="update('image', String($event ?? ''))"
        />
      </ConsolePropertyRow>

      <ConsolePropertyRow icon="i-lucide-link" label="Canonical URL" :control="controlId('canonical')" :error="error('canonical')">
        <UInput
          :id="controlId('canonical')"
          :model-value="text(values.canonical)"
          class="w-full font-mono"
          variant="ghost"
          :disabled="disabled"
          :placeholder="fallbacks.url ?? 'The document URL'"
          @update:model-value="update('canonical', String($event ?? ''))"
        />
      </ConsolePropertyRow>

      <ConsolePropertyRow icon="i-lucide-eye-off" label="Hide from search" :control="controlId('noindex')" :error="error('noindex')">
        <span class="flex h-8 items-center px-2.5">
          <USwitch :id="controlId('noindex')" size="sm" :model-value="noindex" :disabled="disabled" @update:model-value="update('noindex', $event === true)" />
        </span>
      </ConsolePropertyRow>

      <div class="mt-4 grid items-start gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
        <figure class="grid content-start gap-1.5">
          <figcaption class="text-xs text-muted">Search result</figcaption>
          <div class="grid gap-0.5 rounded-lg border border-default p-3" :class="noindex ? 'opacity-50' : undefined">
            <p class="truncate text-xs text-dimmed">{{ breadcrumb }}</p>
            <p class="line-clamp-1 text-sm font-medium text-highlighted">{{ title ? consoleTruncate(title, hint.title.recommended) : "Untitled" }}</p>
            <p class="line-clamp-2 text-xs text-muted">{{ description ? consoleTruncate(description, hint.description.recommended) : "No description. Search engines pick text from the page." }}</p>
          </div>
          <p v-if="noindex" class="text-xs text-muted">Hidden from search results and the sitemap.</p>
        </figure>

        <figure class="grid content-start gap-1.5">
          <figcaption class="text-xs text-muted">Social card</figcaption>
          <div class="overflow-hidden rounded-lg border border-default">
            <div class="relative aspect-[1.91/1] bg-elevated">
              <img
                v-if="imageUrl && !imageFailed"
                :src="imageUrl"
                alt=""
                class="absolute inset-0 size-full object-cover"
                @error="imageFailed = true"
              >
              <div v-else class="absolute inset-0 flex flex-col items-center justify-center gap-1 text-dimmed">
                <UIcon name="i-lucide-image" class="size-5" aria-hidden="true" />
                <span class="text-xs">{{ imageUrl ? "Image not served" : "No image" }}</span>
              </div>
            </div>
            <div class="grid gap-0.5 border-t border-default p-3">
              <p class="truncate text-xs text-dimmed">{{ host }}</p>
              <p class="line-clamp-1 text-sm font-medium text-highlighted">{{ title || "Untitled" }}</p>
              <p v-if="description" class="line-clamp-2 text-xs text-muted">{{ description }}</p>
            </div>
          </div>
        </figure>
      </div>
    </div>
  </section>
</template>
