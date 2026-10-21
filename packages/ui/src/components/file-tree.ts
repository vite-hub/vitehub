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

export const FileTree = defineComponent({
  name: "FileTree",
  inheritAttrs: false,
  props: {
    model: { type: Object as PropType<FileTreeModel> },
    options: { type: Object as PropType<Omit<PierreFileTreeOptions, "paths">> },
    paths: { default: () => [], type: Array as PropType<readonly string[]> },
  },
  setup(props, { attrs, expose }) {
    let host: HTMLElement | null = null;
    let ownedModel: FileTreeModel | undefined;
    let mountedModel: FileTreeModel | undefined;
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
      host.shadowRoot?.querySelector<HTMLElement>("[role='tree']")
        ?.setAttribute("aria-label", attrs["aria-label"] == null ? "Files" : String(attrs["aria-label"]));
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
      }
      if (host) renderModel(model);
    });
    onBeforeUnmount(() => {
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
