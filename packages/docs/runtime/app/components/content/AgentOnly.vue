<script lang="ts">
import { defineComponent } from "vue"

// `::agent-only` content is for coding agents. The site renders nothing; `/raw`, llms-full.txt, and MCP keep it.
export default defineComponent({
  name: "AgentOnly",
  render: () => null,
})
</script>
