<script setup lang="ts">
// Page actions: the Markdown twin of the page, chat tools that read it, and the docs MCP server.
import { useClipboard } from "@vueuse/core"
import { docsMarkdownLinks, docsMcpInstallLinks, findDocsPage } from "#docs/navigation"

const route = useRoute()
const toast = useToast()
const { copy, copied } = useClipboard({ copiedDuring: 1500 })
const { copy: copyLink } = useClipboard()
const manifest = useDocsManifest()
const { mcp, site } = useDocsConfig()
const links = computed(() => findDocsPage(manifest, route.path) ? docsMarkdownLinks(site, route.path) : null)
const copying = ref(false)

async function copyText(text: string, title: string) {
  await copyLink(text)
  toast.add({ title, icon: "i-lucide-check" })
}

async function copyPage() {
  if (!links.value || copying.value) return
  copying.value = true
  try {
    const markdown = await $fetch<string>(links.value.markdownPath, { responseType: "text" })
    await copy(markdown)
  }
  catch {
    toast.add({ title: "Could not copy the page", description: "Open the Markdown view instead.", icon: "i-lucide-x" })
  }
  finally {
    copying.value = false
  }
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
      { label: "View as Markdown", icon: "i-simple-icons-markdown", to: page.markdownPath, target: "_blank" },
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
  <!-- `contents` keeps the group a direct flex item of the page header. The live region sits outside the group,
       because the group rounds its first and last child. -->
  <div v-if="links" class="contents">
    <UFieldGroup size="sm">
      <UButton
        :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
        :loading="copying"
        color="neutral"
        variant="soft"
        aria-label="Copy page as Markdown"
        class="vh-page-action"
        :ui="{ leadingIcon: 'text-neutral size-3.5' }"
        @click="copyPage"
      >
        <!-- Both labels share one grid cell, so "Copied" does not change the width or move the menu button. -->
        <span class="grid">
          <span class="[grid-area:1/1]" :class="{ invisible: copied }">Copy page</span>
          <span class="[grid-area:1/1]" :class="{ invisible: !copied }">Copied</span>
        </span>
      </UButton>

      <UDropdownMenu
        size="sm"
        :items="items"
        :content="{ align: 'end', side: 'bottom', sideOffset: 8 }"
        :ui="{ item: 'pointer-coarse:min-h-11 pointer-coarse:items-center' }"
      >
        <UButton
          icon="i-lucide-chevron-down"
          color="neutral"
          variant="soft"
          aria-label="More page actions"
          class="vh-page-action vh-page-action-more border-l border-muted"
        />
      </UDropdownMenu>
    </UFieldGroup>
    <span class="sr-only" aria-live="polite">{{ copied ? "Page copied as Markdown" : "" }}</span>
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
