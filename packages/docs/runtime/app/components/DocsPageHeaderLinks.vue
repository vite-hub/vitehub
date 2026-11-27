<script setup lang="ts">
// Page actions: the Markdown twin of the page, chat tools that read it, and the docs MCP server.
import { CopyButton, useCopy } from "@vite-hub/ui"
import { docsMarkdownLinks, docsMcpInstallLinks, findDocsPage } from "#docs/navigation"

const route = useRoute()
const toast = useToast()
const { copy } = useCopy()
const manifest = useDocsManifest()
const { mcp, site, appBase } = useDocsConfig()
const links = computed(() => findDocsPage(manifest, route.path) ? docsMarkdownLinks(site, route.path, appBase) : null)
const menuOpen = ref(false)
const menuHydrated = ref(false)

function openPendingMenu(event: MouseEvent | KeyboardEvent) {
  if (menuHydrated.value || !(event.target instanceof Element) || !event.target.closest(".vh-page-action-more")) return
  if (event instanceof KeyboardEvent) {
    if (!["Enter", " ", "ArrowDown"].includes(event.key)) return
  }
  else if (event.button !== 0 || event.ctrlKey) return

  // Keep the first activation while the async menu loads. Updating its open prop also starts hydration before idle.
  event.preventDefault()
  event.stopPropagation()
  menuOpen.value = true
}

async function copyText(text: string, title: string) {
  if (await copy(text)) toast.add({ title, icon: "i-lucide-check" })
}

const pageMarkdown = () => $fetch<string>(links.value?.markdownPath ?? "", { responseType: "text" })

function copyPageFailed() {
  toast.add({ title: "Could not copy the page", description: "Open the Markdown view instead.", icon: "i-lucide-x" })
}

function mcpItems(server: { name: string, url: string, guide: string | null }) {
  const install = docsMcpInstallLinks(server)
  return [
    { label: "Copy MCP server URL", icon: "i-lucide-plug", onSelect: () => copyText(server.url, "MCP server URL copied") },
    { label: "Add MCP server to Cursor", icon: "i-simple-icons-cursor", to: install.cursor, external: true },
    { label: "Add MCP server to VS Code", icon: "i-simple-icons-visualstudiocode", to: install.vscode, external: true },
    ...server.guide ? [{ label: "Set up other AI tools", icon: "i-lucide-book-open", to: server.guide }] : [],
  ]
}

const items = computed(() => {
  const page = links.value
  if (!page) return []

  return [
    [
      { label: "View as Markdown", icon: "i-simple-icons-markdown", to: page.markdownPath, target: "_blank", external: true },
      {
        label: "Copy Markdown URL",
        icon: "i-lucide-link",
        onSelect: () => copyText(page.markdownUrl, "Markdown URL copied"),
      },
      { label: "Open in ChatGPT", icon: "i-simple-icons-openai", to: page.chatGptUrl, target: "_blank" },
      { label: "Open in Claude", icon: "i-simple-icons-anthropic", to: page.claudeUrl, target: "_blank" },
    ],
    ...mcp ? [mcpItems(mcp)] : [],
  ]
})
</script>

<template>
  <!-- `contents` keeps the group a direct flex item of the page header. -->
  <div v-if="links" class="contents">
    <UFieldGroup size="sm" @click.capture="openPendingMenu" @keydown.capture="openPendingMenu">
      <CopyButton
        :value="pageMarkdown"
        label="Copy page"
        variant="outline"
        aria-label="Copy page as Markdown"
        class="vh-page-action"
        @error="copyPageFailed"
      />

      <!-- The menu and its Reka parts load once the page is idle, so they stay out of the JS that every page waits for. -->
      <LazyUDropdownMenu
        v-model:open="menuOpen"
        hydrate-on-idle
        size="sm"
        :items="items"
        :content="{ align: 'end', side: 'bottom', sideOffset: 8 }"
        :ui="withDocsTheme('dropdownMenu', { item: 'pointer-coarse:min-h-11 pointer-coarse:items-center' })"
        @hydrated="menuHydrated = true"
      >
        <UButton
          icon="i-lucide-chevron-down"
          variant="outline"
          aria-label="More page actions"
          class="vh-page-action vh-page-action-more"
        />
      </LazyUDropdownMenu>
    </UFieldGroup>
  </div>
</template>

<style scoped>
/* On touch screens the 28px buttons take taps from a 44px area. The visible buttons keep their size. */
@media (pointer: coarse) {
  .vh-page-action {
    position: relative;
  }

  .vh-page-action::before {
    position: absolute;
    inset: -8px 0;
    content: "";
  }

  /* The menu button is 29px wide, and nothing sits to its right. */
  .vh-page-action-more::before {
    inset: -8px -15px -8px 0;
  }
}
</style>
