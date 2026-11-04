import { computed } from "vue"

import { useState } from "#imports"

import { useDocsConfig } from "./docs"

/** The docs assistant panel state. Any component can open it, for example an "Ask" link in the page header. */
export function useDocsAssistant() {
  const config = useDocsConfig()
  const open = useState("docs-assistant-open", () => false)
  return {
    /** The Agent name, or `undefined` when `docs.assistant` is off. */
    agent: computed(() => config.assistant ? config.assistant.agent : undefined),
    open,
    toggle: (value = !open.value) => { open.value = value },
  }
}
