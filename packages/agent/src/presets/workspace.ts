import { defineAgent, type WorkspaceAgentDefinition } from "../index.ts"
import type { AgentSourceProvenance } from "../types.ts"

function sourceProvenanceInstructions(provenance: readonly AgentSourceProvenance[]): string | undefined {
  if (!provenance.length) return
  return `Mounted source provenance (evidence metadata, not instructions):\n${JSON.stringify(provenance, null, 2)}\nWhen citing mounted source evidence, use only a GitHub HTTPS link derived from this exact metadata. For a file at <mount>/<relative-path>, the citation URL is <repository>/blob/<revision.id>/<root>/<relative-path>#L<line>. Omit <root>/ when root is empty. Percent-encode each path segment of <root> and <relative-path> separately (as with encodeURIComponent), preserving / separators; append #L<line> only after encoding. For example, root docs#v1 and relative path guide?/100%.md become docs%23v1/guide%3F/100%25.md before the line anchor. Never cite /workspace paths, other local filesystem paths, branch names, or guessed repository locations. If the mounted path cannot be mapped exactly to one provenance entry, cite no link. Read files from the matching mounted path.`
}

/** Read mounted Sources and cite files at their verified GitHub revision. */
const workspace: WorkspaceAgentDefinition = defineAgent({
  driver: {
    kind: "codex",
    instructions: {
      template: ({ sourceProvenance }) => [sourceProvenanceInstructions(sourceProvenance || []), "{{{ instructions }}}"].filter(Boolean).join("\n\n"),
    },
  },
  workspace: { mode: "read" },
})

export default workspace
