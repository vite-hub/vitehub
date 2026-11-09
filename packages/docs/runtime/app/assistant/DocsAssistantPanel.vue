<script setup lang="ts">
import { createReusableTemplate, useEventListener, usePreferredReducedMotion } from "@vueuse/core"
import { CopyButton } from "@vite-hub/ui"
import { computed, nextTick, onScopeDispose, ref, useId, watch, watchEffect } from "vue"

import { useAgent, useChat } from "vite-hub/agent/vue"

import { useCookie, useRoute } from "#imports"

import { docsAssistantProblem } from "../composables/docs-assistant-problem"
import { useDocsAssistant } from "../composables/useDocsAssistant"
import { useDocsConfig } from "../composables/docs"

import type { ComponentPublicInstance } from "vue"

const props = defineProps<{ agent: string }>()

const { open, toggle } = useDocsAssistant()
const { appBase } = useDocsConfig()
const route = useRoute()
const chat = useChat(useAgent(props.agent))
const draft = ref("")
const problem = computed(() => chat.error.value ? docsAssistantProblem(chat.error.value, window.location.origin) : undefined)
// The server reads the page path from the request body and adds it to the Agent instructions.
const requestBody = () => ({ body: { page: route.path, appBase } })
const reducedMotion = usePreferredReducedMotion()
const headingId = useId()
const [DefineBody, ReuseBody] = createReusableTemplate()

// From `lg` the panel is a column beside the page. Narrower screens get a modal sheet above the sticky site header.
const wide = window.matchMedia("(min-width: 80rem)")
const docked = ref(wide.matches)
useEventListener(wide, "change", () => { docked.value = wide.matches })

// The width is in pixels: 20rem to 36rem at the default font size, and never more than half the window.
const minWidth = 320
const maxWidth = 576
const defaultWidth = 384
const widthCookie = useCookie<number>("vh-docs-assistant-width", { default: () => defaultWidth, maxAge: 60 * 60 * 24 * 365, sameSite: "lax" })
const clampWidth = (value: number) => Number.isFinite(value) ? Math.round(Math.min(maxWidth, Math.max(minWidth, value))) : defaultWidth
const width = ref(clampWidth(Number(widthCookie.value)))
const resizing = ref(false)

// The docked column is fixed, so the page needs padding on the right to keep its content clear of it.
watchEffect(() => {
  const root = document.documentElement
  if (open.value && docked.value) {
    root.style.setProperty("--vh-assistant-width", `min(${width.value}px, 50vw)`)
    root.dataset.docsAssistant = "docked"
  }
  else {
    root.style.removeProperty("--vh-assistant-width")
    delete root.dataset.docsAssistant
  }
  if (resizing.value) root.dataset.docsAssistantResizing = ""
  else delete root.dataset.docsAssistantResizing
})
onScopeDispose(() => {
  const root = document.documentElement
  root.style.removeProperty("--vh-assistant-width")
  delete root.dataset.docsAssistant
  delete root.dataset.docsAssistantResizing
})

function saveWidth(value: number) {
  width.value = clampWidth(value)
  widthCookie.value = width.value
}

function startResize(event: PointerEvent) {
  if (event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) return
  event.currentTarget.setPointerCapture(event.pointerId)
  resizing.value = true
}

function moveResize(event: PointerEvent) {
  if (resizing.value) width.value = clampWidth(document.documentElement.clientWidth - event.clientX)
}

function endResize() {
  if (!resizing.value) return
  resizing.value = false
  saveWidth(width.value)
}

function resizeWithKeys(event: KeyboardEvent) {
  const step = event.key === "ArrowLeft" ? 16 : event.key === "ArrowRight" ? -16 : 0
  if (!step) return
  event.preventDefault()
  saveWidth(width.value + step)
}

// The phone keyboard shrinks the visual viewport but not the layout viewport, so the sheet follows the visual one and
// the composer stays above the keyboard.
const viewport = ref<{ top: number, height: number }>()
function readViewport() {
  const visual = window.visualViewport
  viewport.value = visual ? { top: visual.offsetTop, height: visual.height } : undefined
}
readViewport()
useEventListener(window.visualViewport, ["resize", "scroll"], readViewport)
const sheetStyle = computed(() => viewport.value ? { top: `${viewport.value.top}px`, bottom: "auto", height: `${viewport.value.height}px` } : undefined)

const heading = ref<HTMLElement>()
const composer = ref<HTMLTextAreaElement>()

/** Whether the device has only coarse pointers. There, Enter adds a line and the Send button sends. */
function touchOnly(): boolean {
  return window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(any-pointer: fine)").matches
}

// PromptInput puts its attributes on the form, so the panel finds the textarea to focus it.
function composerRef(target: Element | ComponentPublicInstance | null) {
  const element = target && "$el" in target ? target.$el : target
  composer.value = element instanceof HTMLElement ? element.querySelector("textarea") ?? undefined : undefined
}

// A focused composer opens the on-screen keyboard over half the sheet, so touch devices focus the heading instead.
function focusInside() {
  if (touchOnly()) heading.value?.focus()
  else composer.value?.focus()
}

// Closing returns focus to the control that opened the panel, or to the Ask button after a keyboard shortcut.
let returnTo: HTMLElement | undefined
watch(open, async (value) => {
  if (value) {
    const active = document.activeElement
    returnTo = active instanceof HTMLElement && active !== document.body && !active.closest("#docs-assistant") ? active : undefined
    // The sheet focuses through `onOpenAutoFocus`, once its content is in the page.
    if (docked.value) {
      await nextTick()
      focusInside()
    }
    return
  }
  await nextTick()
  const target = returnTo?.isConnected ? returnTo : document.getElementById("docs-assistant-trigger")
  target?.focus()
}, { immediate: true })

const sheetContent = computed(() => ({
  style: sheetStyle.value,
  onOpenAutoFocus: (event: Event) => {
    event.preventDefault()
    focusInside()
  },
  // The `open` watcher moves focus.
  onCloseAutoFocus: (event: Event) => event.preventDefault(),
}))

function closeOnEscape(event: KeyboardEvent) {
  if (event.isComposing) return
  event.preventDefault()
  toggle(false)
}

function submit({ text }: { text: string }) {
  if (!text.trim()) return
  draft.value = ""
  void chat.sendMessage({ text }, requestBody())
}

async function restart() {
  void chat.stop()
  chat.messages.value = []
  chat.clearError()
  await nextTick()
  composer.value?.focus()
}
</script>

<template>
  <DefineBody>
    <div id="docs-assistant" class="vh-assistant flex h-full min-h-0 flex-col bg-default">
      <header class="flex h-10 shrink-0 items-center gap-0.5 border-b border-default pr-1.5 pl-3 pointer-coarse:h-12 pointer-coarse:pr-0.5">
        <h2 :id="headingId" ref="heading" tabindex="-1" class="flex-1 text-sm font-medium text-highlighted">
          Ask the docs
        </h2>
        <UButton
          icon="i-lucide-square-pen"
          variant="ghost"
          size="xs"
          class="justify-center pointer-coarse:size-11"
          aria-label="New chat"
          :disabled="!chat.messages.value.length"
          @click="restart"
        />
        <UButton icon="i-lucide-x" variant="ghost" size="xs" class="justify-center pointer-coarse:size-11" aria-label="Close" @click="toggle(false)" />
      </header>
      <Chat v-if="chat.messages.value.length" :messages="chat.messages.value" :status="chat.status.value" class="min-h-0 flex-1" />
      <p v-else class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 text-sm text-muted">
        Answers come from these docs, with links to the pages they use.
      </p>
      <div v-if="problem" role="alert" class="shrink-0 border-t border-default px-3 py-2 text-sm" :data-code="problem.code">
        <p class="font-medium text-highlighted">
          {{ problem.title }}
        </p>
        <p class="text-muted">
          {{ problem.detail }}
        </p>
        <div v-if="problem.command" class="mt-1.5 flex items-start gap-1 bg-elevated py-1 pr-1 pl-2">
          <code class="min-w-0 flex-1 py-0.5 font-mono text-xs/5 whitespace-pre-wrap text-highlighted [overflow-wrap:anywhere]">{{ problem.command }}</code>
          <CopyButton
            :value="problem.command"
            label="Copy"
            aria-label="Copy the command"
            size="xs"
            class="shrink-0 pointer-coarse:h-11"
          />
        </div>
      </div>
      <PromptInput
        :ref="composerRef"
        v-model="draft"
        class="shrink-0 border-t border-default p-2"
        placeholder="Ask a question"
        :attachments="false"
        :status="chat.status.value"
        @submit="submit"
        @stop="chat.stop()"
        @reload="chat.regenerate(requestBody())"
      />
    </div>
  </DefineBody>

  <aside
    v-if="docked"
    v-show="open"
    class="vh-assistant-dock"
    :aria-labelledby="headingId"
    @keydown.esc="closeOnEscape"
  >
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panel"
      :aria-valuenow="width"
      :aria-valuemin="minWidth"
      :aria-valuemax="maxWidth"
      tabindex="0"
      class="vh-assistant-resize"
      @pointerdown="startResize"
      @pointermove="moveResize"
      @pointerup="endResize"
      @pointercancel="endResize"
      @dblclick="saveWidth(defaultWidth)"
      @keydown="resizeWithKeys"
    />
    <ReuseBody />
  </aside>
  <USlideover
    v-else
    v-model:open="open"
    title="Ask the docs"
    description="Answers come from these docs."
    :transition="reducedMotion !== 'reduce'"
    :content="sheetContent"
    :ui="{ content: 'max-w-none pb-[env(safe-area-inset-bottom)] sm:max-w-[26rem]' }"
  >
    <template #content>
      <ReuseBody />
    </template>
  </USlideover>
</template>

<style scoped>
.vh-assistant {
  --vh-chat-content-padding: 1rem 0.75rem 1.5rem;
}

.vh-assistant-dock {
  position: fixed;
  z-index: 40;
  inset-block: 0;
  right: 0;
  width: var(--vh-assistant-width);
  border-left: 1px solid var(--ui-border);
}

/* An 8px strip over the left border. The border line shows the hover and drag state; the theme draws focus. */
.vh-assistant-resize {
  position: absolute;
  z-index: 1;
  inset-block: 0;
  left: -5px;
  width: 9px;
  cursor: col-resize;
  touch-action: none;
}

.vh-assistant-resize::after {
  position: absolute;
  inset-block: 0;
  left: 4px;
  width: 1px;
  content: "";
  transition: background-color 150ms ease-out;
}

.vh-assistant-resize:hover::after {
  background: var(--ui-border-accented);
}
</style>

<style>
/* The page keeps its content clear of the docked panel. Below 80rem the panel is a sheet, so prose keeps its width. */
@media (min-width: 80rem) {
  html[data-docs-assistant="docked"] {
    padding-right: var(--vh-assistant-width);
  }
}

html[data-docs-assistant-resizing] {
  cursor: col-resize;
  user-select: none;
}

html[data-docs-assistant-resizing] .vh-assistant-resize::after {
  background: var(--ui-border-accented);
}
</style>
