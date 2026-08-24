import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const docsRoot = resolve(import.meta.dirname, "..");
const uiDocsRoot = resolve(docsRoot, "content/docs/ui");
const examplesRoot = resolve(docsRoot, "app/components/content/examples");

const previews = {
  "attachments.md": ["ChatPromptExample"],
  "chat-message.md": ["ChatMessageExample"],
  "chat-prompt.md": ["ChatPromptExample"],
  "chat.md": ["ChatExample"],
  "diff.md": ["DiffExample"],
  "file-tree.md": ["FileTreeExample"],
  "invocation-inspector.md": ["InvocationInspectorExample"],
  "invocation-list.md": ["InvocationListExample"],
  "invocation.md": ["InvocationExample"],
  "markdown.md": ["MarkdownExample"],
  "message-parts.md": ["MessagePartsExample"],
  "message-scroller.md": ["MessageScrollerExample"],
  "session.md": ["SessionExample"],
  "trace.md": ["TraceExample"],
} as const;

describe("UI documentation", () => {
  it("renders overview cards through supported MDC component frontmatter", () => {
    const source = readFileSync(resolve(uiDocsRoot, "index.md"), "utf8");

    expect(source.match(/  :::u-page-card/g)).toHaveLength(4);
    expect(source).not.toContain(":::u-page-card\n\n---");
  });

  it("gives every visual component page a source-backed live preview", () => {
    for (const [page, names] of Object.entries(previews)) {
      const source = readFileSync(resolve(uiDocsRoot, page), "utf8");
      for (const name of names) {
        expect(source, `${page} should render ${name}`).toContain(
          `::component-preview{name="${name}"`,
        );
        expect(existsSync(resolve(examplesRoot, `${name}.vue`)), name).toBe(true);
      }
    }
  });

  it("sends component preview source through the Markdown syntax highlighter", () => {
    const preview = readFileSync(
      resolve(docsRoot, "app/components/content/ComponentPreview.vue"),
      "utf8",
    );

    expect(preview).toContain('import highlighter from "#mdc-highlighter"');
    expect(preview).toContain('<MDC :value="sourceBlock"');
    expect(preview).toContain(':parser-options="sourceParserOptions"');
    expect(preview).not.toContain("<code>{{ source }}</code>");
  });

  it("loads previews through the public Nuxt module", () => {
    const config = readFileSync(resolve(docsRoot, "nuxt.config.ts"), "utf8");
    const manifest = readFileSync(resolve(docsRoot, "package.json"), "utf8");

    expect(config).toContain('"@vite-hub/ui/nuxt"');
    expect(manifest).toContain('"@vite-hub/ui": "workspace:*"');
  });

  it("uses the wide component layout without the desktop outline", () => {
    const page = readFileSync(resolve(docsRoot, "app/pages/docs/[...slug].vue"), "utf8");
    const styles = readFileSync(resolve(docsRoot, "app/assets/main.css"), "utf8");

    expect(page).toContain('path.startsWith("/docs/ui/")');
    expect(page).toContain('root: "lg:!grid-cols-1 lg:!gap-0"');
    expect(page).toContain('<DocsAsideRight v-if="!isUiPage"');
    expect(styles).toContain(".docs-ui-page-shell");
    expect(styles).toContain("max-width: 68rem");
  });

  it("gives invocation previews fixed-height containing blocks", () => {
    const invocation = readFileSync(resolve(examplesRoot, "InvocationExample.vue"), "utf8");
    const inspector = readFileSync(
      resolve(examplesRoot, "InvocationInspectorExample.vue"),
      "utf8",
    );

    expect(invocation).toContain('<div class="h-[34rem]');
    expect(invocation).toContain('class="h-full"');
    expect(inspector).toContain('<div class="mx-auto h-[36rem]');
    expect(inspector).toContain('class="h-full border-x border-default"');
  });
});
