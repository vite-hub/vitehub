import { computed } from "vue"

import { useRuntimeConfig, useState } from "#imports"

import type { DocsPublicConfig } from "@vite-hub/docs/nuxt"

/** The docs assistant panel state. Any component can open it, for example an "Ask" link in the page header. */
export function useDocsAssistant() {
  const config: DocsPublicConfig = useRuntimeConfig().public.docs
  const open = useState("docs-assistant-open", () => false)
  return {
    /** The Agent name, or `undefined` when `docs.assistant` is off. */
    agent: computed(() => config.assistant ? config.assistant.agent : undefined),
    open,
    toggle: (value = !open.value) => { open.value = value },
  }
}
