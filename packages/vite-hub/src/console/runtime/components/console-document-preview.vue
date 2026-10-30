<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

import {
  consolePreviewAddress,
  consolePreviewError,
  consolePreviewField,
  consolePreviewFormAction,
  consolePreviewFormValue,
  consolePreviewMobileWidth,
  consolePreviewPublishedUrl,
} from "../client/preview";
import { consoleErrorMessage } from "../client/documents";

import type { ConsoleDocumentPreview, ConsoleDocumentsClient } from "../client/documents";
import type { ConsolePreviewDocument, ConsolePreviewView, ConsolePreviewViewport } from "../client/preview";

/**
 * The side browser of the document editor, with its own toolbar. The draft view posts the document on screen to the
 * page URL with a signed token, so the site renders it with its own routes and nothing is saved. The published view
 * loads the page with `?vitehub-content-published`, so it shows what guests see even when this browser has a whole-site
 * preview cookie, which stays as it is. Each render loads into a new frame and replaces the old one when it is ready, so
 * the page does not flash and the Console history does not grow.
 *
 * Elements that `contentField()` marks select their field in the editor. Text fields of this document become editable
 * in place in the draft view.
 */
const props = defineProps<{
  client: ConsoleDocumentsClient;
  collection: { name: string, kind: "documents" | "singleton" };
  documentId: string;
  /** The page of the document on this origin. */
  url: URL;
  /** The document on screen for the draft view. */
  document: ConsolePreviewDocument;
  /** Fields that can change in place: top-level text fields. Empty when this tab cannot edit. */
  textFields: readonly string[];
  /** The edits on screen are local to this tab. */
  local: boolean;
  /** The field focused in the editor, outlined in the page. */
  highlight?: string;
  /** Increments to load the page again, such as after a publish. */
  reloads: number;
  /** On a small screen the preview covers the editor and offers a way back. */
  overlay: boolean;
}>();

const view = defineModel<ConsolePreviewView>("view", { required: true });
const viewport = defineModel<ConsolePreviewViewport>("viewport", { required: true });
const emit = defineEmits<{ close: [], edit: [field: string, value: string], select: [field: string] }>();

interface Frame {
  key: number;
  name: string;
  src?: string;
}

/** How long the document must stay the same before the draft view renders it again. */
const renderDelay = 350;
const frames = ref<Frame[]>([]);
const shown = ref<number>();
const address = ref(props.url.pathname);
const failure = ref<string>();
const loading = ref(false);
const frameStack = ref<HTMLElement>();
let frameCount = 0;
/** Counts renders. A render that waited on the token stops when a newer render, or unmount, started meanwhile. */
let generation = 0;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
let token: { document: string, value: ConsoleDocumentPreview } | undefined;
/** The element edited in place. The page does not render again until it loses focus. */
let editing: HTMLElement | undefined;
let renderPending = false;

const frameName = (key: number) => `vitehub-preview-${props.collection.name}-${key}`.replace(/[^\w-]/g, "-");
const draft = computed(() => view.value === "draft");
const label = computed(() => (view.value === "published" ? "Published" : props.local ? "Local draft" : "Draft"));

async function freshToken(): Promise<ConsoleDocumentPreview> {
  // A token signs one document. Ask again a minute before it expires.
  const document = JSON.stringify([props.collection.name, props.documentId]);
  if (token?.document === document && Date.parse(token.value.expiresAt) - Date.now() > 60_000) return token.value;
  const value = await props.client.preview(props.collection.name, props.documentId);
  token = { document, value };
  return value;
}

/** Loads the page into a new frame. The shown frame stays until the new one loads. */
async function render(): Promise<void> {
  clearTimeout(renderTimer);
  if (editing) {
    renderPending = true;
    return;
  }
  renderPending = false;
  const run = ++generation;
  failure.value = undefined;
  loading.value = true;
  let form: { action: string, field: string, value: string } | undefined;
  if (draft.value) {
    try {
      const current = await freshToken();
      if (run !== generation) return;
      form = { action: consolePreviewFormAction(props.url, current.parameter), field: current.parameter, value: consolePreviewFormValue(current.token, props.document) };
    }
    catch (error) {
      if (run !== generation) return;
      loading.value = false;
      failure.value = consoleErrorMessage(error, "The Console could not open the preview.");
      return;
    }
  }
  const key = ++frameCount;
  const name = frameName(key);
  // Keep the shown frame and the newest one. Older frames that did not load yet are dropped.
  frames.value = [...frames.value.filter(frame => frame.key === shown.value), form ? { key, name } : { key, name, src: consolePreviewPublishedUrl(props.url) }];
  if (!form) return;
  await nextTick();
  // A form whose frame is gone would open a new window, so a newer render or unmount stops it here.
  if (run !== generation || !frameStack.value?.querySelector(`iframe[name="${name}"]`)) return;
  // A form POST into a new frame replaces its first blank page, so it adds no history entry.
  const element = document.createElement("form");
  element.method = "post";
  element.action = form.action;
  element.target = name;
  element.hidden = true;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = form.field;
  input.value = form.value;
  element.append(input);
  document.body.append(element);
  element.submit();
  element.remove();
}

function scheduleRender(): void {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => void render(), renderDelay);
}

/** The document of a frame, only while it shows a page of this origin. */
function frameDocument(frame: HTMLIFrameElement): Document | undefined {
  try {
    const location = frame.contentWindow?.location;
    if (!location || location.origin !== window.location.origin) return;
    return frame.contentDocument ?? undefined;
  }
  catch {
    // A page on another origin cannot be read.
    return undefined;
  }
}

function onFrameLoad(frame: Frame, event: Event): void {
  const element = event.target;
  if (!(element instanceof HTMLIFrameElement)) return;
  let href: string | undefined;
  try {
    href = element.contentWindow?.location.href;
  }
  catch {
    // A page on another origin, such as after a link in the published view.
  }
  // A new frame first loads its blank page, before the form or the source.
  if (href === "about:blank") return;
  if (frame.key !== frameCount) {
    // A newer render started; this frame stays hidden and goes away with it.
    return;
  }
  const previous = frameStack.value?.querySelector<HTMLIFrameElement>(`iframe[name="${frameName(shown.value ?? -1)}"]`);
  const scroll = previous ? frameDocument(previous)?.defaultView?.scrollY : undefined;
  shown.value = frame.key;
  loading.value = false;
  frames.value = frames.value.filter(entry => entry.key === frame.key);
  const page = frameDocument(element);
  if (!page) {
    address.value = "";
    return;
  }
  address.value = consolePreviewAddress(page.location);
  // The site could not show the document, so the frame would show its error page under the Draft label.
  const error = draft.value ? consolePreviewError(page) : undefined;
  if (error) {
    failure.value = error;
    return;
  }
  if (scroll) page.defaultView?.scrollTo(0, scroll);
  instrument(page);
}

const highlightAttribute = "data-vitehub-preview-highlight";

/** Outlines the fields of this document, and makes clicks on them select or edit their field. */
function instrument(page: Document): void {
  const style = page.createElement("style");
  style.textContent = `
    [data-content-field] { cursor: ${draft.value ? "pointer" : "default"}; }
    ${draft.value ? `[data-content-field]:hover { outline: 1px dashed color-mix(in oklab, #3b82f6 70%, transparent); outline-offset: 3px; }` : ""}
    [${highlightAttribute}] { outline: 2px solid #3b82f6 !important; outline-offset: 3px; }
    [contenteditable] { outline: 2px solid #3b82f6 !important; outline-offset: 3px; cursor: text; }
  `;
  page.head.append(style);
  page.addEventListener("click", event => onPageClick(page, event), true);
  applyHighlight(page);
}

/** An element of the page. Its elements belong to the frame's window, so `instanceof Element` of the Console fails. */
function pageElement(page: Document, target: EventTarget | null): Element | undefined {
  const PageElement = page.defaultView?.Element;
  return PageElement && target instanceof PageElement ? target : undefined;
}

function fieldElement(page: Document, target: EventTarget | null): { element: HTMLElement, field: string, nested: boolean } | undefined {
  const element = pageElement(page, target)?.closest<HTMLElement>("[data-content-field]");
  if (!element) return;
  const match = consolePreviewField(element.getAttribute("data-content-field"), props.collection, props.documentId);
  return match ? { element, ...match } : undefined;
}

function onPageClick(page: Document, event: MouseEvent): void {
  const target = fieldElement(page, event.target);
  // The draft view previews this document only: links would leave it for a page without the draft.
  const link = pageElement(page, event.target)?.closest("a[href]");
  if (draft.value && (link || target)) event.preventDefault();
  if (!target || !draft.value || target.element === editing) return;
  event.stopPropagation();
  emit("select", target.field);
  if (!target.nested && props.textFields.includes(target.field)) startEditing(page, target.element, target.field);
}

/** Edits a text field in the page. Enter or leaving the element ends the edit; Escape puts the text back. */
function startEditing(page: Document, element: HTMLElement, field: string): void {
  const original = element.textContent ?? "";
  // The element may format its field, such as "Category: News"; edit the raw value and keep the display for Escape.
  const stored = props.document.data[field];
  const value = String(stored) === stored ? stored : original;
  editing = element;
  element.textContent = value;
  element.setAttribute("contenteditable", "plaintext-only");
  element.setAttribute("aria-label", `Edit ${field}`);
  element.focus();
  const selection = page.getSelection();
  selection?.selectAllChildren(element);
  selection?.collapseToEnd();
  const onInput = () => emit("edit", field, (element.textContent ?? "").replace(/\s*\n\s*/g, " "));
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      element.blur();
    }
    if (event.key === "Escape") {
      element.textContent = original;
      emit("edit", field, value);
      element.blur();
    }
  };
  const onBlur = () => {
    if (element.textContent === value) element.textContent = original;
    element.removeEventListener("input", onInput);
    element.removeEventListener("keydown", onKeydown);
    element.removeAttribute("contenteditable");
    element.removeAttribute("aria-label");
    editing = undefined;
    if (renderPending) scheduleRender();
  };
  element.addEventListener("input", onInput);
  element.addEventListener("keydown", onKeydown);
  element.addEventListener("blur", onBlur, { once: true });
}

function shownDocument(): Document | undefined {
  const frame = frameStack.value?.querySelector<HTMLIFrameElement>(`iframe[name="${frameName(shown.value ?? -1)}"]`);
  return frame ? frameDocument(frame) : undefined;
}

function applyHighlight(page = shownDocument()): void {
  if (!page) return;
  for (const element of page.querySelectorAll(`[${highlightAttribute}]`)) element.removeAttribute(highlightAttribute);
  if (!props.highlight) return;
  let first: Element | undefined;
  for (const element of page.querySelectorAll("[data-content-field]")) {
    if (consolePreviewField(element.getAttribute("data-content-field"), props.collection, props.documentId)?.field !== props.highlight) continue;
    element.setAttribute(highlightAttribute, "");
    first ??= element;
  }
  first?.scrollIntoView({ block: "nearest" });
}

/** Opens the page in a new tab: the draft view posts the same form there. */
async function openInTab(): Promise<void> {
  if (!draft.value) {
    window.open(consolePreviewPublishedUrl(props.url), "_blank", "noopener");
    return;
  }
  try {
    const current = await freshToken();
    const element = document.createElement("form");
    element.method = "post";
    element.action = consolePreviewFormAction(props.url, current.parameter);
    element.target = "_blank";
    element.rel = "noopener";
    element.hidden = true;
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = current.parameter;
    input.value = consolePreviewFormValue(current.token, props.document);
    element.append(input);
    document.body.append(element);
    element.submit();
    element.remove();
  }
  catch (error) {
    failure.value = consoleErrorMessage(error, "The Console could not open the preview.");
  }
}

function onRadioKeydown(event: KeyboardEvent, select: (next: "first" | "last" | "other") => void): void {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  select(event.key === "Home" ? "first" : event.key === "End" ? "last" : "other");
  const group = event.currentTarget instanceof Element ? event.currentTarget.closest('[role="radiogroup"]') : null;
  void nextTick(() => group?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus());
}

// Each source compares by value: a save gives the editor a new URL object for the same page, which renders nothing.
watch([view, () => props.url.href, () => props.reloads], () => void render(), { immediate: true });
watch(() => JSON.stringify(props.document), () => {
  if (draft.value) scheduleRender();
});
watch(() => props.highlight, () => applyHighlight());
onBeforeUnmount(() => {
  generation++;
  clearTimeout(renderTimer);
});
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-col bg-default" aria-label="Page preview">
    <div class="flex h-11 shrink-0 items-center gap-1.5 border-b border-default px-2 sm:px-3">
      <UButton v-if="overlay" variant="ghost" size="sm" icon="i-lucide-arrow-left" label="Editor" @click="emit('close')" />
      <UTooltip text="Reload" :content="{ side: 'bottom' }">
        <UButton variant="ghost" size="sm" icon="i-lucide-rotate-cw" aria-label="Reload the preview" :loading="loading" @click="render" />
      </UTooltip>
      <div class="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md bg-elevated/60 px-2.5 ring-1 ring-default ring-inset">
        <UIcon :name="view === 'published' ? 'i-lucide-globe' : 'i-lucide-eye'" class="size-3.5 shrink-0 text-dimmed" aria-hidden="true" />
        <span class="truncate font-mono text-xs text-muted" :title="address">{{ address || url.pathname }}</span>
        <span
          class="ms-auto shrink-0 rounded-sm px-1.5 py-0.5 text-[11px]/none font-medium"
          :class="view === 'published' ? 'bg-success/10 text-success' : local ? 'bg-warning/10 text-warning' : 'bg-info/10 text-info'"
          role="status"
        >{{ label }}</span>
      </div>
      <div class="flex items-center rounded-md p-0.5 ring-1 ring-default ring-inset" role="radiogroup" aria-label="Preview">
        <button
          v-for="option in [{ label: 'Draft', value: 'draft' }, { label: 'Published', value: 'published' }] as const"
          :key="option.value"
          type="button"
          role="radio"
          class="h-6 rounded-[4px] px-2 text-xs focus-visible:outline-2"
          :class="view === option.value ? 'bg-elevated text-highlighted' : 'text-muted hover:text-highlighted'"
          :aria-checked="view === option.value"
          :tabindex="view === option.value ? 0 : -1"
          @click="view = option.value"
          @keydown="onRadioKeydown($event, (next) => (view = next === 'first' ? 'draft' : next === 'last' ? 'published' : view === 'draft' ? 'published' : 'draft'))"
        >
          {{ option.label }}
        </button>
      </div>
      <div class="hidden items-center rounded-md p-0.5 ring-1 ring-default ring-inset sm:flex" role="radiogroup" aria-label="Viewport">
        <UTooltip v-for="option in [{ label: 'Desktop', value: 'desktop', icon: 'i-lucide-monitor' }, { label: 'Mobile', value: 'mobile', icon: 'i-lucide-smartphone' }] as const" :key="option.value" :text="option.label" :content="{ side: 'bottom' }">
          <button
            type="button"
            role="radio"
            class="grid size-6 place-items-center rounded-[4px] focus-visible:outline-2"
            :class="viewport === option.value ? 'bg-elevated text-highlighted' : 'text-muted hover:text-highlighted'"
            :aria-checked="viewport === option.value"
            :aria-label="option.label"
            :tabindex="viewport === option.value ? 0 : -1"
            @click="viewport = option.value"
            @keydown="onRadioKeydown($event, (next) => (viewport = next === 'first' ? 'desktop' : next === 'last' ? 'mobile' : viewport === 'desktop' ? 'mobile' : 'desktop'))"
          >
            <UIcon :name="option.icon" class="size-3.5" aria-hidden="true" />
          </button>
        </UTooltip>
      </div>
      <UTooltip text="Open in a new tab" :content="{ side: 'bottom' }">
        <UButton variant="ghost" size="sm" icon="i-lucide-external-link" aria-label="Open the preview in a new tab" @click="openInTab" />
      </UTooltip>
      <UTooltip v-if="!overlay" text="Close the preview" :content="{ side: 'bottom' }">
        <UButton variant="ghost" size="sm" icon="i-lucide-x" aria-label="Close the preview" @click="emit('close')" />
      </UTooltip>
    </div>
    <div class="relative min-h-0 flex-1 overflow-auto" :class="viewport === 'mobile' ? 'bg-elevated/40 px-4 py-5' : ''">
      <div v-if="failure" class="grid justify-items-start gap-3 p-6" role="alert">
        <p class="text-sm text-muted">{{ failure }}</p>
        <UButton variant="outline" size="sm" label="Retry" @click="render" />
      </div>
      <div
        v-else
        ref="frameStack"
        class="relative mx-auto h-full bg-white"
        :class="viewport === 'mobile' ? 'overflow-hidden rounded-[1.25rem] shadow-sm ring-1 ring-default' : 'w-full'"
        :style="viewport === 'mobile' ? { width: `${consolePreviewMobileWidth}px`, maxWidth: '100%' } : undefined"
      >
        <iframe
          v-for="frame in frames"
          :key="frame.key"
          :name="frameName(frame.key)"
          :src="frame.src"
          :title="`${label} preview of ${address || url.pathname}`"
          referrerpolicy="same-origin"
          class="absolute inset-0 size-full border-0"
          :class="frame.key === shown ? '' : 'invisible'"
          :aria-hidden="frame.key === shown ? undefined : 'true'"
          :tabindex="frame.key === shown ? undefined : -1"
          @load="onFrameLoad(frame, $event)"
        />
      </div>
    </div>
  </section>
</template>
