import { formFields } from "@vite-hub/forms"

import { type Catalog, type CatalogSurface } from "./define.ts"
import { viteHubCatalog } from "./entries.ts"
import { toJsonRenderCatalog } from "./json-render.ts"
import { formProblem, maxSpecDepth, maxSpecElements } from "./validate.ts"

import type { FormField } from "@vite-hub/forms"

export interface CatalogPromptOptions {
  /** The surface where the spec renders. The prompt lists only the components of this surface. */
  surface: CatalogSurface
  /** The built-in catalog by default. */
  catalog?: Catalog
  /**
   * `"standalone"` (default): the model answers with JSONL patches only. `"inline"`: the model writes text first, then
   * the patches, as in a chat.
   */
  mode?: "standalone" | "inline"
}

const surfaceNotes: Record<CatalogSurface, string> = {
  web: "The UI renders in a web page.",
  mcp: "The UI renders in an MCP App inside the person's AI client.",
  chatCard: "The UI renders as a card in a chat message. A card has no inputs: to ask for values, send a Form in a chat modal.",
  chatModal: "The UI renders as a chat modal, such as a Slack modal. Put one Form in it.",
}

function fieldLine(field: FormField): string {
  const kind = field.options ? `one of ${field.options.map(option => JSON.stringify(option)).join(", ")}` : field.format ? `${field.type} (${field.format})` : field.type
  return `  - ${field.name}: ${kind}${field.required ? ", required" : ""}. ${field.label}${field.description ? `: ${field.description}` : ""}`
}

/**
 * The system prompt that teaches a model to write UI for one surface: json-render's own prompt for the catalog (the
 * prompt that the C4 first-try evals measured), with the surface, the limits, and the fields of each form of the catalog.
 *
 * @example
 * ```ts
 * const system = `${instructions}\n\n${catalogPrompt({ surface: "web", catalog })}`
 * ```
 */
export function catalogPrompt(options: CatalogPromptOptions): string {
  const catalog = options.catalog ?? viteHubCatalog
  // A Form of a form that the surface cannot draw fails validation, so the prompt leaves it out.
  const forms = Object.entries(catalog.forms).filter(([, source]) => !formProblem(source, options.surface))
  const rules = [
    surfaceNotes[options.surface],
    `Use at most ${maxSpecElements} elements and ${maxSpecDepth} levels.`,
    "Tell the Agent what the person chose with the event action, such as { \"action\": \"event\", \"params\": { \"name\": \"deploy.approve\", \"context\": { \"id\": \"dpl_81\" } } }.",
    forms.length
      ? [
          "Ask for values only with a Form. Name one of these forms in its form prop, bind its value to a state path, and send that path in the context of on.submit:",
          ...forms.map(([name, source]) => [`- ${name}:`, ...formFields(source).map(fieldLine)].join("\n")),
        ].join("\n")
      : "Do not ask for values: the app has no forms.",
  ]
  return toJsonRenderCatalog({ surface: options.surface, catalog }).prompt({ mode: options.mode ?? "standalone", customRules: rules })
}
