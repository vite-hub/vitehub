import { FILE_TREE_TAG_NAME, FileTree, type FileTreeOptions } from "@pierre/trees";
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

export interface AgentFileTreeOptions extends Omit<FileTreeOptions, "paths"> {
  paths: readonly string[];
}

export function useAgentFileTree(options: AgentFileTreeOptions): FileTree {
  const model = markRaw(new FileTree(options));
  if (getCurrentScope()) onScopeDispose(() => model.cleanUp());
  return model;
}

export function useAgentFileTreeSelection(model: FileTree) {
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

export const AgentFileTree = defineComponent({
  name: "AgentFileTree",
  inheritAttrs: false,
  props: {
    model: { type: Object as PropType<FileTree> },
    options: { type: Object as PropType<Omit<FileTreeOptions, "paths">> },
    paths: { default: () => [], type: Array as PropType<readonly string[]> },
  },
  setup(props, { attrs, expose }) {
    let host: HTMLElement | null = null;
    let ownedModel: FileTree | undefined;
    let previousPaths = props.paths;
    let previousOptions = props.options;
    const current = () =>
      props.model
        ? toRaw(props.model)
        : (ownedModel ??= markRaw(new FileTree({ ...toRaw(props.options), paths: props.paths })));
    const setHost = (node: Element | null) => {
      host = node instanceof HTMLElement ? node : null;
      if (host) current().render({ fileTreeContainer: host });
    };
    onUpdated(() => {
      if (!props.model && previousOptions !== props.options) {
        ownedModel?.cleanUp();
        ownedModel = markRaw(new FileTree({ ...toRaw(props.options), paths: props.paths }));
        previousOptions = props.options;
        previousPaths = props.paths;
      }
      const model = current();
      if (previousPaths !== props.paths) {
        model.resetPaths(props.paths);
        previousPaths = props.paths;
      }
      if (host) model.render({ fileTreeContainer: host });
    });
    onBeforeUnmount(() => {
      if (ownedModel) ownedModel.cleanUp();
      else current().unmount();
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
