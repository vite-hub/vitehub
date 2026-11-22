import { defineComponent, h, type PropType } from "vue";

/** The cursor position that `WorkspaceEditor` emits with `cursor`. Both numbers start at 1. */
export interface WorkspaceCursor {
  line: number;
  column: number;
}

const languages: Record<string, string> = {
  astro: "Astro",
  cjs: "JavaScript",
  css: "CSS",
  html: "HTML",
  js: "JavaScript",
  json: "JSON",
  jsonc: "JSON with Comments",
  jsonl: "JSON Lines",
  jsx: "JavaScript JSX",
  md: "Markdown",
  mdx: "MDX",
  mjs: "JavaScript",
  mts: "TypeScript",
  svelte: "Svelte",
  ts: "TypeScript",
  tsx: "TypeScript JSX",
  vue: "Vue",
};

/** The name of the language of `path`, as VS Code shows it, such as `TypeScript` for `app.ts`. */
export function workspaceLanguage(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const type = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return Object.hasOwn(languages, type) ? languages[type]! : "Plain Text";
}

/**
 * The status line under the editor: the cursor line and column, the language of the open file, and the indentation.
 * Put it in the `status` slot of `WorkspaceShell`, which makes the line 24px high.
 */
export const WorkspaceStatus = defineComponent({
  name: "WorkspaceStatus",
  props: {
    /** The path of the open file. It names the language. */
    path: { required: true, type: String },
    /** The cursor, from the `cursor` event of `WorkspaceEditor`. */
    cursor: { default: () => ({ column: 1, line: 1 }), type: Object as PropType<WorkspaceCursor> },
    /** The language name. By default it comes from the file extension. */
    language: { default: undefined, type: String },
    /** The indentation: a number of spaces, or `"tab"`. */
    indent: { default: 2, type: [Number, String] as PropType<number | "tab"> },
  },
  setup(props, { slots }) {
    return () => {
      const language = props.language ?? workspaceLanguage(props.path);
      const indent = props.indent === "tab" ? "Tabs" : `Spaces: ${props.indent}`;
      return h("div", { class: "vh-ws-status-items" }, [
        h("span", { class: "vh-ws-status-cursor" }, [
          h("span", { "aria-hidden": "true" }, `Ln ${props.cursor.line}, Col ${props.cursor.column}`),
          h("span", { class: "vh-ws-sr-only" }, `Line ${props.cursor.line}, column ${props.cursor.column}`),
        ]),
        // In a narrow pane these two shorten. The title keeps their full text.
        h("span", { title: language }, language),
        h("span", { title: indent }, indent),
        slots.default ? [h("span", { class: "vh-ws-status-spacer" }), slots.default()] : undefined,
      ]);
    };
  },
});
