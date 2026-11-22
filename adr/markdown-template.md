# @vite-hub/markdown-template decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Markdown template: no fs at module load, decoded link checks, no data in on* or srcdoc

`renderMarkdownFile`, `safeLinkDestination`, `rejectBoundEventHandlers`, `sanitizeUrlAttributes` in `packages/markdown-template/src/file.ts`, `packages/markdown-template/src/links.ts`, `packages/markdown-template/src/render.ts`.

**Context:** Workers have no fs; browsers decode entities; on* and srcdoc run as script or HTML.

**Decision:** Lazy fs import; Comark 0.9 decodes authored attribute entities once, and the link policy runs on that decoded value; reject bound data on these attributes.

**Consequences:** Works on Workers; no XSS through data bindings.

## Tell a JSON literal from a data path with JSON.parse, as Comark does

`isJsonLiteral` in `packages/markdown-template/src/bindings.ts`, used by `resolveTemplateAttributes` and `matchesCondition` in `packages/markdown-template/src/condition.ts`.

**Context:** Comark 0.9.0 resolves a bound attribute with `resolveAttributes`, which tries `JSON.parse` on the value and reads it as a data path when the parse throws. Comark does not export that check. A template check that disagrees with it would accept a path that Comark reads as a literal, or the reverse.

**Decision:** One local `isJsonLiteral` with the same rule, a `JSON.parse` that returns `true` or `false`, shared by bindings and conditions.

**Consequences:** It must follow Comark's rule. It can go when Comark (comarkdown/comark) exports its literal check.

## Keep an HTML-only paragraph inline

`inlineHtml` in `packages/markdown-template/src/parser.ts`.

**Context:** Comark 0.9.0 lifts a paragraph whose only child is inline HTML into a block, so `<policy>Use it.</policy>` renders with line breaks around it. Removing the plugin fails four tests.

**Decision:** `htmlPlugins` keeps `inlineHtml`, which marks those elements inline again.

**Consequences:** It can go when Comark stops lifting inline HTML out of its paragraph.

## Mask component lines before Comark parses the template

`prepareTemplate` in `packages/markdown-template/src/prepare.ts`.

**Context:** Comark 0.9.0 parses a line that starts with `:` as a block component even inside a multi-line inline code span, so a template that shows component syntax in code renders a component. Removing the masking fails three tests.

**Decision:** Replace component lines with tokens, find the tokens that land in code, and restore the original lines after parsing.

**Consequences:** It can go when Comark parses code spans before block components.

## Drop the extra line break after an opening raw block tag

The `rawBlockTags` child handling in `renderMarkdownTemplateInternal` in `packages/markdown-template/src/render.ts`.

**Context:** For a block `<script>`, `<style>`, or `<textarea>`, Comark 0.9.0 keeps the line break after the opening tag in the first child text, and its HTML renderer adds another, so `<script>\nlet a` renders as `<script>\n\nlet a`.

**Decision:** Strip one leading line break from the first child of these tags.

**Consequences:** It can go when Comark's HTML renderer stops doubling that line break.

## Find the link label opener when Comark drops an escape

`labelStart` in `packages/markdown-template/src/render.ts`, used by `rejectLinkDestinationBinding`.

**Context:** Comark 0.9.0 drops the backslash of an escaped bracket in link text, so `[a\]b]` reaches the renderer as the text `[a]b]`, and bracket depth alone cannot find where the label starts.

**Decision:** When the bracket count does not balance, fall back to the last unescaped `[`.

**Consequences:** It can go when Comark keeps escape information in the text it returns.

## Escape ampersands before writing authored HTML attributes

**Context:** Comark parses HTML attribute references, but its serializer keeps text that looks like a reference. For example, it can write the decoded text `&copy;` as a reference rather than as literal text.

**Decision:** Escape ampersands after URL validation and before handing attributes to the HTML serializer. Comark escapes the other attribute characters.

**Consequences:** The browser reads the same attribute text that the parser saw. URL validation does not decode the value again.
