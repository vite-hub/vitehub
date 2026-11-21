import { computed, defineComponent, h, onBeforeUnmount, type PropType, watch } from "vue";
import { FileTree, useFileTree } from "../components/file-tree.ts";
import { fileTreeIcons } from "./file-icons.ts";

// Pierre draws its rows in a shadow DOM, so the styles of the rows go in through `unsafeCSS`. The custom properties of
// styles.css reach in through the host. Pierre marks an edited file with the letter M and a folder that holds one with
// a dot: draw one accent dot at the end of the file row, and none on folders.
const treeCSS = `
[data-type="item"][data-item-selected="true"] { box-shadow: inset 1px 0 0 var(--vh-ws-accent); }
[data-type="item"][data-item-type="folder"] > [data-item-section="content"] { color: var(--vh-highlighted); }
[data-type="item"][data-item-type="folder"] > [data-item-section="icon"] { color: var(--trees-fg-muted); }
[data-type="item"][data-item-type="folder"] > [data-item-section="icon"] svg { height: 14px; width: 14px; }
[data-type="item"][data-item-type="file"] > [data-item-section="icon"] { margin-inline-start: calc(var(--trees-icon-width) + var(--trees-item-row-gap)); }
[data-item-git-status] > :where([data-item-section="icon"]) > *, [data-item-git-status] > [data-item-section="content"] { color: inherit; }
[data-item-section="git"] { align-items: center; display: flex; justify-content: flex-end; opacity: 1; }
[data-item-section="git"] > span { font-size: 0; }
[data-item-section="git"] > span svg { display: none; }
[data-item-git-status="modified"] > [data-item-section="git"] > span { background: var(--vh-ws-accent); border-radius: 50%; flex: none; height: 6px; margin-inline-end: 2px; width: 6px; }
`;

/** The file list of a workspace, with an icon per file type and a dot on each edited file. */
export const WorkspaceFileTree = defineComponent({
  name: "WorkspaceFileTree",
  props: {
    paths: { required: true, type: Array as PropType<readonly string[]> },
    /** Paths that differ from the original files, such as `workspace.modified`. A list or a set. */
    edited: { default: () => [], type: [Array, Set] as PropType<readonly string[] | ReadonlySet<string>> },
    /** The open file. Use `v-model:selected`. */
    selected: { default: undefined, type: String },
    label: { default: "Project files", type: String },
  },
  emits: {
    "update:selected": (path: string) => typeof path === "string",
  },
  setup(props, { emit }) {
    const edited = computed(() => [...props.edited].sort());
    const gitStatus = (paths: readonly string[]) => paths.map(path => ({ path, status: "modified" as const }));
    const model = useFileTree({
      density: "compact",
      gitStatus: gitStatus(edited.value),
      icons: fileTreeIcons,
      initialExpansion: "open",
      initialSelectedPaths: props.selected ? [props.selected] : undefined,
      itemHeight: 22,
      paths: props.paths,
      unsafeCSS: treeCSS,
      onSelectionChange(paths) {
        const path = paths.at(-1);
        if (path && !path.endsWith("/") && path !== props.selected) emit("update:selected", path);
      },
    });
    watch(() => edited.value.join("\n"), () => model.setGitStatus(gitStatus(edited.value)));
    watch(() => props.paths, paths => model.resetPaths(paths));
    watch(() => props.selected, (path) => {
      if (path && model.getSelectedPaths().at(-1) !== path) model.getItem(path)?.select();
    });
    onBeforeUnmount(() => model.cleanUp());
    return () => h(FileTree, { "aria-label": props.label, class: "vh-ws-file-tree", model });
  },
});
