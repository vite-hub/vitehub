<!-- `DocsAssistant` when `docs.assistant` is off: the shell renders it unconditionally, and it renders nothing. -->
<script lang="ts">
import { defineComponent } from "vue"

// Not a template with only a comment: production builds drop the comment, so the server renders nothing while the
// browser renders an empty placeholder, and every page fails hydration. A render function gives both the placeholder.
export default defineComponent({ name: "DocsAssistantOff", render: () => null })
</script>
