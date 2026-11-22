import { defineComponent, h, onBeforeUnmount, onBeforeUpdate, onMounted, onUpdated, type PropType, ref } from "vue";
import { createMotionList, type MotionList as MotionListController } from "../motion/list.ts";

/**
 * A list whose items move with the list mover of `@vite-hub/ui/motion` (docs/design/motion.md, "Items are added,
 * removed, or reordered"). Use it in place of `<TransitionGroup>`: render keyed items in its slot. When they change,
 * neighbors spring to their new place, a new item grows from `origin` or from its slot, and a removed item folds away
 * or leaves toward `target`.
 */
export const MotionList = defineComponent({
  name: "MotionList",
  props: {
    tag: { default: "div", type: String },
    origin: { default: undefined, type: Function as PropType<(item: HTMLElement) => Element | null | undefined> },
    target: { default: undefined, type: Function as PropType<() => Element | null | undefined> },
  },
  setup(props, { slots }) {
    const root = ref<HTMLElement>();
    let list: MotionListController | undefined;
    onMounted(() => {
      if (root.value) list = createMotionList(root.value);
    });
    onBeforeUpdate(() => list?.measure());
    onUpdated(() => list?.play({ origin: props.origin, target: props.target?.() }));
    onBeforeUnmount(() => list?.destroy());
    return () => h(props.tag, { ref: root }, slots.default?.());
  },
});
