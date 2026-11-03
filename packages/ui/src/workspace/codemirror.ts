import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, HighlightStyle, indentOnInput, type LanguageSupport, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";

// Token colors use CSS variables from styles.css, so the editor follows the Pierre light and dark themes of `FileView`.
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

const theme = EditorView.theme({
  "&": { backgroundColor: "var(--vh-ws-code-bg)", color: "var(--vh-ws-code-fg)", fontSize: "13px", height: "100%" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--vh-ws-font-mono)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--vh-ws-code-cursor)", paddingBlock: "8px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--vh-ws-code-cursor)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--vh-ws-code-selection)" },
  ".cm-activeLine": { backgroundColor: "var(--vh-ws-code-line)" },
  ".cm-gutters": { backgroundColor: "var(--vh-ws-code-bg)", border: "none", color: "var(--vh-ws-code-gutter)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--vh-ws-code-gutter-active)" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "3ch", paddingInline: "12px 8px" },
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
  label: string
  onChange: (doc: string) => void
}

export interface CodeEditor {
  setDoc: (doc: string, path: string) => void
  setReadonly: (readonly: boolean) => void
  focus: () => void
  destroy: () => void
}

export function createCodeEditor(options: CodeEditorOptions): CodeEditor {
  const language = new Compartment();
  const editable = new Compartment();
  let path = options.path;
  // Set while the document is replaced from outside, so that the change does not go back to the parent.
  let applying = false;
  let readonly = options.readonly;
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
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
    theme,
    language.of([]),
    editable.of(editableExtension()),
    EditorView.contentAttributes.of({ "aria-label": options.label }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !applying) options.onChange(update.state.doc.toString());
    }),
  ];

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
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
