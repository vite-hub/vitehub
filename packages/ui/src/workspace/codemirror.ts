import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, HighlightStyle, indentOnInput, type LanguageSupport, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import pierreDark from "@pierre/theme/pierre-dark";
import pierreLight from "@pierre/theme/pierre-light";

// The TextMate scope whose color each kind of token takes in the Pierre themes. Comments and punctuation are gray, so
// they take the muted text tokens of styles.css instead.
const syntaxScopes = {
  attribute: "entity.other.attribute-name",
  function: "entity.name.function",
  keyword: "keyword",
  number: "constant.numeric",
  string: "string",
  tag: "entity.name.tag",
  type: "entity.name.type",
  variable: "variable",
} as const;

/** The `--vh-ws-code-*` syntax colors of one Pierre theme, the same ones that `FileView` paints. */
function syntaxColors(theme: typeof pierreLight): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const [name, scope] of Object.entries(syntaxScopes)) {
    const rule = theme.tokenColors.find(({ scope: scopes }) => (typeof scopes === "string" ? scopes.split(",").map(item => item.trim()) : scopes ?? []).includes(scope));
    const color = rule?.settings.foreground;
    if (color) colors[`--vh-ws-code-${name}`] = color;
  }
  return colors;
}

// Token colors use CSS variables, so the editor follows the Pierre light and dark themes of `FileView`.
const pierreHighlight = HighlightStyle.define([
  { color: "var(--vh-ws-code-comment)", fontStyle: "italic", tag: tags.comment },
  { color: "var(--vh-ws-code-keyword)", tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.definitionKeyword, tags.modifier] },
  { color: "var(--vh-ws-code-string)", tag: [tags.string, tags.special(tags.string), tags.regexp] },
  { color: "var(--vh-ws-code-number)", tag: [tags.number, tags.bool, tags.null, tags.atom] },
  { color: "var(--vh-ws-code-function)", tag: [tags.function(tags.variableName), tags.function(tags.propertyName)] },
  { color: "var(--vh-ws-code-type)", tag: [tags.typeName, tags.className, tags.namespace] },
  { color: "var(--vh-ws-code-variable)", tag: [tags.propertyName, tags.definition(tags.variableName)] },
  { color: "var(--vh-ws-code-tag)", tag: [tags.tagName, tags.heading] },
  { color: "var(--vh-ws-code-attribute)", tag: tags.attributeName },
  { color: "var(--vh-ws-code-punctuation)", tag: [tags.punctuation, tags.operator, tags.bracket] },
  { fontWeight: "600", tag: tags.strong },
  { fontStyle: "italic", tag: tags.emphasis },
  { color: "var(--vh-ws-code-string)", tag: tags.link, textDecoration: "underline" },
]);

// The surface, the gutter, the caret, and the selection come from the `--vh-ws-code-*` tokens of styles.css.
const theme = EditorView.theme({
  "&": { ...syntaxColors(pierreLight), backgroundColor: "var(--vh-ws-code-bg)", color: "var(--vh-ws-code-fg)", fontSize: "12.5px", height: "100%" },
  ".dark &": syntaxColors(pierreDark),
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--vh-ws-font-mono)", lineHeight: "1.65" },
  ".cm-content": { caretColor: "var(--vh-ws-code-cursor)", paddingBlock: "8px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--vh-ws-code-cursor)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--vh-ws-code-selection)" },
  ".cm-activeLine": { backgroundColor: "var(--vh-ws-code-line)" },
  ".cm-gutters": { backgroundColor: "var(--vh-ws-code-bg)", border: "none", color: "var(--vh-ws-code-gutter)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--vh-ws-code-gutter-active)" },
  // The line numbers take 28px and a 16px gap: the code starts 44px from the edge, as in the files of the prototype.
  ".cm-lineNumbers .cm-gutterElement": { boxSizing: "content-box", minWidth: "28px", padding: "0 16px 0 0" },
  ".cm-line": { padding: "0 16px 0 0" },
  ".cm-matchingBracket": { backgroundColor: "var(--vh-ws-code-selection)", outline: "none" },
});

async function languageFor(path: string): Promise<LanguageSupport | undefined> {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (extension) {
    case "js": case "mjs": case "cjs":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "jsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "ts": case "mts": case "cts":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true });
    case "json": case "jsonc":
      return (await import("@codemirror/lang-json")).json();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "md": case "mdx":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "vue":
      return (await import("@codemirror/lang-vue")).vue();
    default:
      return undefined;
  }
}

export interface CodeEditorOptions {
  parent: HTMLElement
  doc: string
  path: string
  readonly: boolean
  wrap: boolean
  onChange: (doc: string) => void
  /** Alt+Z asks for the other wrap state, as in VS Code. The editor wraps when `setWrap` gets it. */
  onToggleWrap: () => void
  /** The cursor moved. The line and the column start at 1. */
  onCursor: (cursor: { line: number, column: number }) => void
}

export interface CodeEditor {
  setDoc: (doc: string, path: string) => void
  setReadonly: (readonly: boolean) => void
  setWrap: (wrap: boolean) => void
  focus: () => void
  destroy: () => void
}

/**
 * Match the layout's Z key or the US Mac Option+Z chord (`Ω` on `KeyZ`). A physical `KeyZ` alone can be a typing key.
 */
function isToggleWrap(event: KeyboardEvent): boolean {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  return event.key.toLowerCase() === "z" || (event.key === "Ω" && event.code === "KeyZ");
}

export function createCodeEditor(options: CodeEditorOptions): CodeEditor {
  const language = new Compartment();
  const editable = new Compartment();
  const wrapping = new Compartment();
  let path = options.path;
  // Set while the document is replaced from outside, so that the change does not go back to the parent.
  let applying = false;
  let readonly = options.readonly;
  let wrap = options.wrap;
  const editableExtension = () => [EditorState.readOnly.of(readonly), EditorView.editable.of(!readonly)];

  const extensions = (): Extension[] => [
    lineNumbers(),
    highlightActiveLineGutter(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    syntaxHighlighting(pierreHighlight),
    EditorView.domEventHandlers({ keydown: (event) => {
      if (!isToggleWrap(event)) return false;
      event.preventDefault();
      options.onToggleWrap();
      return true;
    } }),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
    theme,
    language.of([]),
    editable.of(editableExtension()),
    wrapping.of(wrap ? EditorView.lineWrapping : []),
    EditorView.contentAttributes.of({ "aria-label": `Edit ${path}` }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !applying) options.onChange(update.state.doc.toString());
      if (update.docChanged || update.selectionSet) reportCursor(update.state);
    }),
  ];

  function reportCursor(state: EditorState) {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    options.onCursor({ column: head - line.from + 1, line: line.number });
  }

  const view = new EditorView({ doc: options.doc, extensions: extensions(), parent: options.parent });

  function loadLanguage(target: string) {
    void languageFor(target).then((support) => {
      if (path === target) view.dispatch({ effects: language.reconfigure(support ?? []) });
    });
  }
  loadLanguage(path);

  return {
    setDoc(doc, nextPath) {
      if (nextPath !== path) {
        path = nextPath;
        applying = true;
        // A new file gets a fresh state, so undo does not go back into the previous file.
        view.setState(EditorState.create({ doc, extensions: extensions() }));
        applying = false;
        reportCursor(view.state);
        loadLanguage(path);
        return;
      }
      if (doc === view.state.doc.toString()) return;
      applying = true;
      view.dispatch({ changes: { from: 0, insert: doc, to: view.state.doc.length } });
      applying = false;
    },
    setReadonly(next) {
      readonly = next;
      view.dispatch({ effects: editable.reconfigure(editableExtension()) });
    },
    setWrap(next) {
      if (next === wrap) return;
      wrap = next;
      view.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
