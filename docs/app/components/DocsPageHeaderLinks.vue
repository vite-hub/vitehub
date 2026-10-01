<script setup lang="ts">
// Replaces the Docus page header actions. Docus builds the raw Markdown URL from
// `route.path`, so trailing-slash routes such as `/docs/agents/` point to
// `/raw/docs/agents/.md`. These actions use the same raw route mapping as llms.txt.
import { useClipboard } from "@vueuse/core";
import {
  cursorMcpInstallUrl,
  docsMcpUrl,
  pageActionLinks,
  vscodeMcpInstallUrl,
} from "~~/modules/vitehub-docs/runtime/utils/page-actions";

const route = useRoute();
const toast = useToast();
const { copy, copied } = useClipboard({ copiedDuring: 1500 });
const { copy: copyLink } = useClipboard();
const links = computed(() => pageActionLinks(route.path));
const copying = ref(false);

async function copyText(text: string, title: string) {
  await copyLink(text);
  toast.add({ title, icon: "i-lucide-check" });
}

async function copyPage() {
  if (!links.value || copying.value) return;
  copying.value = true;
  try {
    const markdown = await $fetch<string>(links.value.markdownPath, { responseType: "text" });
    await copy(markdown);
  }
  catch {
    toast.add({ title: "Could not copy the page", description: "Open the Markdown view instead.", icon: "i-lucide-x" });
  }
  finally {
    copying.value = false;
  }
}

const items = computed(() => {
  const page = links.value;
  if (!page) return [];

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
    [
      {
        label: "Copy MCP server URL",
        icon: "i-lucide-plug",
        onSelect: () => copyText(docsMcpUrl, "MCP server URL copied"),
      },
      { label: "Add MCP server to Cursor", icon: "i-simple-icons-cursor", to: cursorMcpInstallUrl(), external: true },
      { label: "Add MCP server to VS Code", icon: "i-simple-icons-visualstudiocode", to: vscodeMcpInstallUrl(), external: true },
      { label: "Set up other AI tools", icon: "i-lucide-book-open", to: "/docs/ai-resources/mcp-server" },
    ],
  ];
});
</script>

<template>
  <UFieldGroup v-if="links" size="sm">
    <UButton
      :label="copied ? 'Copied' : 'Copy page'"
      :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
      :loading="copying"
      color="neutral"
      variant="soft"
      aria-label="Copy page as Markdown"
      :ui="{ leadingIcon: 'text-neutral size-3.5' }"
      @click="copyPage"
    />

    <UDropdownMenu
      size="sm"
      :items="items"
      :content="{ align: 'end', side: 'bottom', sideOffset: 8 }"
    >
      <UButton
        icon="i-lucide-chevron-down"
        color="neutral"
        variant="soft"
        aria-label="More page actions"
        class="border-l border-muted"
      />
    </UDropdownMenu>
  </UFieldGroup>
</template>
