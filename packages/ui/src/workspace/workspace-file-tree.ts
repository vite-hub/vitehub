import { defineComponent, h, onBeforeUnmount, type PropType, watch } from "vue";
import { FileTree, useFileTree } from "../components/file-tree.ts";

// Pierre marks a modified file with the letter M and a folder that holds one with a dot. Draw a dot for both, in ink, not hue.
const modifiedDotCSS = `
:host { --trees-git-modified-color-override: var(--vh-ui-muted, currentColor); }
[data-item-section="git"] > span { font-size: 0; }
[data-item-section="git"] > span svg { display: none; }
[data-item-section="git"] > span::after { background: currentColor; border-radius: 50%; content: ""; display: inline-block; height: 6px; width: 6px; }
`;

/** The file list of a workspace. A dot marks each modified file, and the folders that hold one. */
export const WorkspaceFileTree = defineComponent({
  name: "WorkspaceFileTree",
  props: {
    paths: { required: true, type: Array as PropType<readonly string[]> },
    /** Paths that differ from the original files, such as `workspace.modified`. */
    modified: { default: () => [], type: Array as PropType<readonly string[]> },
    /** The open file. Use `v-model:selected`. */
    selected: { default: undefined, type: String },
    label: { default: "Project files", type: String },
  },
  emits: {
    "update:selected": (path: string) => typeof path === "string",
  },
  setup(props, { emit }) {
    const model = useFileTree({
      initialExpansion: "open",
      initialSelectedPaths: props.selected ? [props.selected] : undefined,
      paths: props.paths,
      gitStatus: props.modified.map(path => ({ path, status: "modified" as const })),
      unsafeCSS: modifiedDotCSS,
      onSelectionChange(paths) {
        const path = paths.at(-1);
        if (path && !path.endsWith("/") && path !== props.selected) emit("update:selected", path);
      },
    });
    watch(() => props.modified, (next) => {
      model.setGitStatus(next.map(path => ({ path, status: "modified" as const })));
    });
    watch(() => props.paths, paths => model.resetPaths(paths));
    watch(() => props.selected, (path) => {
      if (path && model.getSelectedPaths().at(-1) !== path) model.getItem(path)?.select();
    });
    onBeforeUnmount(() => model.cleanUp());
    return () => h(FileTree, { "aria-label": props.label, class: "vh-ws-file-tree", model });
  },
});
