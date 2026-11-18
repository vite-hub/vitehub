import type { ChainedCommands, Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";

/**
 * What an editor menu item asks for. `kind` names the handler that runs it, and the other fields are its arguments:
 * the mark to toggle, the heading level, or the position of the block that the block menu acts on.
 */
export interface EditorItem {
  kind?: string;
  mark?: string;
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  pos?: number;
}

/** Runs one `kind` of item on an editor. The toolbar, the "/" menu, and the block menu read the same handlers. */
export interface EditorHandler {
  canExecute: (editor: Editor, item: EditorItem) => boolean;
  execute: (editor: Editor, item: EditorItem) => { run: () => unknown };
  isActive: (editor: Editor, item: EditorItem) => boolean;
  isDisabled?: (editor: Editor, item: EditorItem) => boolean;
}

export type EditorHandlers = Record<string, EditorHandler>;

/**
 * The key that the editor parts read their handlers from, as a `Ref<EditorHandlers>`. It is the string that Nuxt UI's
 * editor components inject, so one `provide()` serves both sets.
 */
export const editorHandlersKey = "editorHandlers";

function isNodeTypeSelected(editor: Editor, types: string[]): boolean {
  const { $from, to } = editor.state.selection;
  let found = false;
  editor.state.doc.nodesBetween($from.pos, to, (node) => {
    if (types.includes(node.type.name)) found = true;
  });
  return found;
}

const hasExtension = (editor: Editor, name: string): boolean => editor.extensionManager.extensions.some(extension => extension.name === name);

// Text blocks take no formatting while an image is selected or the caret is in inline code.
const blocked = (editor: Editor): boolean => isNodeTypeSelected(editor, ["image"]) || editor.isActive("code");

function blockHandler(name: string, toggle: (chain: ChainedCommands) => ChainedCommands, can: (editor: Editor) => boolean): EditorHandler {
  return {
    canExecute: can,
    execute: editor => toggle(editor.chain().focus()),
    isActive: editor => editor.isActive(name),
    isDisabled: blocked,
  };
}

const listItemTypes = ["bulletList", "orderedList"] as const;

function listHandler(type: (typeof listItemTypes)[number]): EditorHandler {
  const toggle = (chain: ChainedCommands) => (type === "bulletList" ? chain.toggleBulletList() : chain.toggleOrderedList());
  const inAnyList = (editor: Editor) => listItemTypes.some(name => hasExtension(editor, name) && editor.isActive(name));
  return {
    canExecute: editor => (type === "bulletList" ? editor.can().toggleBulletList() : editor.can().toggleOrderedList()) || editor.isActive("listItem") || inAnyList(editor),
    execute: (editor) => {
      const { selection } = editor.state;
      let chain = editor.chain().focus();
      // A block selected by the block handle turns into a list with its text selected.
      if (selection instanceof NodeSelection) {
        const first = selection.node.firstChild?.firstChild;
        const last = selection.node.lastChild?.lastChild;
        const from = first ? selection.from + first.nodeSize : selection.from + 1;
        const to = last ? selection.to - last.nodeSize : selection.to - 1;
        chain = chain.setTextSelection({ from, to }).clearNodes();
      }
      const lift = (current: ChainedCommands) => {
        let result = current.liftListItem("listItem");
        for (const name of listItemTypes) if (hasExtension(editor, name)) result = result.lift(name);
        return result;
      };
      if (editor.isActive(type)) return lift(chain).selectTextblockEnd();
      if (inAnyList(editor)) return toggle(lift(chain)).selectTextblockEnd();
      return toggle(chain).selectTextblockEnd();
    },
    isActive: editor => editor.isActive(type),
    isDisabled: editor => !hasExtension(editor, type) || blocked(editor),
  };
}

// The block at `pos`, which the block menu acts on, with its position.
function blockAt(editor: Editor, item: EditorItem) {
  const node = item.pos == null ? null : editor.state.doc.nodeAt(item.pos);
  return node && item.pos != null ? { node, pos: item.pos } : undefined;
}

function moveHandler(direction: "up" | "down"): EditorHandler {
  const target = (editor: Editor, item: EditorItem) => {
    const block = blockAt(editor, item);
    if (!block) return undefined;
    const $pos = editor.state.doc.resolve(block.pos);
    const index = $pos.index();
    if (direction === "up" ? index <= 0 : index >= $pos.parent.childCount - 1) return undefined;
    const neighbor = $pos.parent.child(direction === "up" ? index - 1 : index + 1);
    return { ...block, to: direction === "up" ? block.pos - neighbor.nodeSize : block.pos + neighbor.nodeSize };
  };
  return {
    canExecute: (editor, item) => Boolean(target(editor, item)),
    execute: (editor, item) => {
      const move = target(editor, item);
      if (!move) return editor.chain();
      return editor.chain().focus().deleteRange({ from: move.pos, to: move.pos + move.node.nodeSize }).insertContentAt(move.to, move.node.toJSON());
    },
    isActive: () => false,
  };
}

/**
 * The handlers of the item kinds that ViteHub's editors use: `mark` (with `mark`), `heading` (with `level`),
 * `paragraph`, `blockquote`, `codeBlock`, `horizontalRule`, `bulletList`, `orderedList`, and, for the block at `pos`,
 * `duplicate`, `delete`, `moveUp`, `moveDown`, and `suggestion` (opens the "/" menu below it). They match Nuxt UI's
 * `createHandlers()` for these kinds. Spread your own over them for other kinds.
 */
export function createEditorHandlers(): EditorHandlers {
  return {
    mark: {
      canExecute: (editor, { mark = "" }) => editor.can().toggleMark(mark),
      execute: (editor, { mark = "" }) => editor.chain().focus().toggleMark(mark),
      isActive: (editor, { mark = "" }) => editor.isActive(mark),
      isDisabled: (editor, { mark = "" }) => !editor.schema.marks[mark] || isNodeTypeSelected(editor, ["image"]),
    },
    heading: {
      canExecute: (editor, { level = 1 }) => editor.can().toggleHeading({ level }),
      execute: (editor, { level = 1 }) => editor.chain().focus().toggleHeading({ level }),
      isActive: (editor, item) => editor.isActive("heading", { level: item.level }),
      isDisabled: blocked,
    },
    paragraph: blockHandler("paragraph", chain => chain.setParagraph(), editor => editor.can().setParagraph()),
    blockquote: blockHandler("blockquote", chain => chain.toggleBlockquote(), editor => editor.can().toggleBlockquote()),
    codeBlock: blockHandler("codeBlock", chain => chain.toggleCodeBlock(), editor => editor.can().toggleCodeBlock()),
    horizontalRule: blockHandler("horizontalRule", chain => chain.setHorizontalRule(), editor => editor.can().setHorizontalRule()),
    bulletList: listHandler("bulletList"),
    orderedList: listHandler("orderedList"),
    duplicate: {
      canExecute: (editor, item) => Boolean(blockAt(editor, item)),
      execute: (editor, item) => {
        const block = blockAt(editor, item);
        return block ? editor.chain().focus().insertContentAt(block.pos + block.node.nodeSize, block.node.toJSON()) : editor.chain();
      },
      isActive: () => false,
    },
    delete: {
      canExecute: (editor, item) => Boolean(blockAt(editor, item)),
      execute: (editor, item) => {
        const block = blockAt(editor, item);
        return block ? editor.chain().focus().deleteRange({ from: block.pos, to: block.pos + block.node.nodeSize }) : editor.chain();
      },
      isActive: () => false,
    },
    moveUp: moveHandler("up"),
    moveDown: moveHandler("down"),
    suggestion: {
      canExecute: () => true,
      execute: (editor, item) => {
        const slash = { content: [{ text: "/", type: "text" }], type: "paragraph" };
        const block = blockAt(editor, item);
        if (block) return editor.chain().focus().insertContentAt(block.pos + block.node.nodeSize, slash);
        const { $from } = editor.state.selection;
        return editor.chain().focus().insertContentAt($from.before($from.depth) + $from.node($from.depth).nodeSize, slash);
      },
      isActive: () => false,
    },
  };
}

/** A menu entry that `mapEditorItems()` reads: an editor item, or a label or separator, with any menu fields. */
export type EditorMenuEntry = EditorItem & { type?: "label" | "separator" | "link" | "checkbox", children?: EditorMenuEntry[] | EditorMenuEntry[][], [field: string]: unknown };

/** An entry after `mapEditorItems()`: what the editor item says it is, as a dropdown menu entry. */
export type MappedEditorMenuEntry = EditorMenuEntry & { active?: boolean, disabled?: boolean, onSelect?: () => void };

/**
 * Turns editor items into dropdown menu entries: each item with a known `kind` gets `active`, `disabled`, and an
 * `onSelect` that runs its handler, as Nuxt UI's `mapEditorItems()` does. Groups and `children` keep their shape.
 */
export function mapEditorItems(editor: Editor, items: EditorMenuEntry[], handlers?: EditorHandlers): MappedEditorMenuEntry[];
export function mapEditorItems(editor: Editor, items: EditorMenuEntry[][], handlers?: EditorHandlers): MappedEditorMenuEntry[][];
export function mapEditorItems(editor: Editor, items: EditorMenuEntry[] | EditorMenuEntry[][], handlers?: EditorHandlers): MappedEditorMenuEntry[] | MappedEditorMenuEntry[][] {
  const all = { ...createEditorHandlers(), ...handlers };
  const map = (group: EditorMenuEntry[]): MappedEditorMenuEntry[] => group.filter(Boolean).map((entry) => {
    if (entry.type) return entry;
    const { children, ...rest } = entry;
    const mappedChildren = children?.length ? (Array.isArray(children[0]) ? (children as EditorMenuEntry[][]).map(map) : map(children as EditorMenuEntry[])) : undefined;
    const handler = entry.kind ? all[entry.kind] : undefined;
    if (!handler) return { ...rest, children: mappedChildren };
    return {
      ...rest,
      active: handler.isActive(editor, entry),
      children: mappedChildren,
      disabled: Boolean(handler.isDisabled?.(editor, entry)) || !handler.canExecute(editor, entry),
      onSelect: () => void handler.execute(editor, entry).run(),
    };
  });
  return items.length && Array.isArray(items[0]) ? (items as EditorMenuEntry[][]).map(map) : map(items as EditorMenuEntry[]);
}
