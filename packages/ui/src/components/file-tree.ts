import { FILE_TREE_TAG_NAME, FileTree as PierreFileTree, type FileTreeOptions as PierreFileTreeOptions } from "@pierre/trees";
import {
  defineComponent,
  getCurrentScope,
  h,
  markRaw,
  onBeforeUnmount,
  onScopeDispose,
  onUpdated,
  type PropType,
  shallowRef,
  toRaw,
  type VNodeRef,
  watch,
} from "vue";

/** The Pierre tree model that `useFileTree()` returns and `FileTree` renders. */
export type FileTreeModel = PierreFileTree;

export interface FileTreeOptions extends Omit<PierreFileTreeOptions, "paths"> {
  paths: readonly string[];
}

export function useFileTree(options: FileTreeOptions): FileTreeModel {
  const model = markRaw(new PierreFileTree(options));
  if (getCurrentScope()) onScopeDispose(() => model.cleanUp());
  return model;
}

export function useFileTreeSelection(model: FileTreeModel) {
  const selectedPaths = shallowRef<readonly string[]>(model.getSelectedPaths());
  const unsubscribe = model.subscribe(() => {
    const next = model.getSelectedPaths();
    if (
      next.length !== selectedPaths.value.length ||
      next.some((path, index) => path !== selectedPaths.value[index])
    ) {
      selectedPaths.value = next;
    }
  });
  if (getCurrentScope()) onScopeDispose(unsubscribe);
  return selectedPaths;
}

/** The selected file. A selected folder does not count. */
function selectedFile(model: FileTreeModel) {
  return model.getSelectedPaths().findLast((path) => model.getItem(path)?.isDirectory() === false);
}

/** Selects only `path`, opens its folders, and scrolls to it. Clears the selection when the tree has no such file. */
function selectFile(model: FileTreeModel, path: string) {
  const file = model.getItem(path);
  for (const other of model.getSelectedPaths()) if (other !== path) model.getItem(other)?.deselect();
  if (!file || file.isDirectory()) return;
  const folders = path.split("/").slice(0, -1);
  for (let depth = 1; depth <= folders.length; depth++) {
    const folder = model.getItem(folders.slice(0, depth).join("/"));
    if (folder && "expand" in folder && !folder.isExpanded()) folder.expand();
  }
  file.select();
  model.scrollToPath(path);
}

export const FileTree = defineComponent({
  name: "FileTree",
  inheritAttrs: false,
  props: {
    model: { type: Object as PropType<FileTreeModel> },
    options: { type: Object as PropType<Omit<PierreFileTreeOptions, "paths">> },
    paths: { default: () => [], type: Array as PropType<readonly string[]> },
    searchLabel: { default: "Search files", type: String },
    selectedPath: { type: String },
  },
  emits: {
    "update:selectedPath": (_path: string) => true,
  },
  setup(props, { attrs, emit, expose }) {
    let host: HTMLElement | null = null;
    let ownedModel: FileTreeModel | undefined;
    let mountedModel: FileTreeModel | undefined;
    // The model and file that the tree and `selectedPath` last agreed on.
    let synced: { model: FileTreeModel; path: string | undefined } | undefined;
    let stopSelection: (() => void) | undefined;
    const syncSelection = (model: FileTreeModel) => {
      if (synced?.model !== model) {
        stopSelection?.();
        stopSelection = model.subscribe(() => {
          const path = selectedFile(model);
          if (path === undefined || path === synced?.path) return;
          synced = { model, path };
          emit("update:selectedPath", path);
        });
        synced = { model, path: props.selectedPath === undefined ? selectedFile(model) : undefined };
      }
      if (props.selectedPath === undefined || props.selectedPath === synced.path) return;
      synced.path = props.selectedPath;
      selectFile(model, props.selectedPath);
    };
    let previousPaths = props.paths;
    let previousOptions = props.options;
    const current = () =>
      props.model
        ? toRaw(props.model)
        : (ownedModel ??= markRaw(new PierreFileTree({ ...toRaw(props.options), paths: props.paths })));
    const releaseMountedModel = () => {
      if (!mountedModel) return;
      if (mountedModel === ownedModel) {
        mountedModel.cleanUp();
        ownedModel = undefined;
      } else mountedModel.unmount();
      mountedModel = undefined;
    };
    const renderModel = (model: FileTreeModel) => {
      if (!host) return;
      if (mountedModel !== model) releaseMountedModel();
      model.render({ fileTreeContainer: host });
      mountedModel = model;
      syncSelection(model);
      // Pierre has no option to name the tree or its search input, which has only a placeholder.
      host.shadowRoot?.querySelector<HTMLElement>("[role='tree']")
        ?.setAttribute("aria-label", attrs["aria-label"] == null ? "Files" : String(attrs["aria-label"]));
      host.shadowRoot?.querySelector<HTMLElement>("[data-file-tree-search-input]")
        ?.setAttribute("aria-label", props.searchLabel);
    };
    const setHost = (node: Element | null) => {
      host = node instanceof HTMLElement ? node : null;
      if (host) renderModel(current());
    };
    onUpdated(() => {
      if (!props.model && previousOptions !== props.options) {
        if (mountedModel === ownedModel) releaseMountedModel();
        else ownedModel?.cleanUp();
        ownedModel = markRaw(new PierreFileTree({ ...toRaw(props.options), paths: props.paths }));
        previousOptions = props.options;
        previousPaths = props.paths;
      }
      const model = current();
      if (previousPaths !== props.paths) {
        model.resetPaths(props.paths);
        previousPaths = props.paths;
        // New paths can drop the selected file, or add it.
        if (synced?.model === model && props.selectedPath !== undefined) synced.path = undefined;
      }
      if (host) renderModel(model);
    });
    watch(
      () => props.selectedPath,
      () => {
        if (mountedModel) syncSelection(mountedModel);
      },
      { flush: "post" },
    );
    onBeforeUnmount(() => {
      stopSelection?.();
      releaseMountedModel();
      ownedModel?.cleanUp();
      ownedModel = undefined;
    });
    expose({ getModel: current });
    return () =>
      h(FILE_TREE_TAG_NAME, {
        ...attrs,
        class: ["vh-file-tree", attrs.class],
        ref: setHost as VNodeRef,
        style: [
          {
            "--trees-density-override": current().getDensityFactor(),
            "--trees-item-height": `${current().getItemHeight()}px`,
          },
          attrs.style,
        ],
      });
  },
});
