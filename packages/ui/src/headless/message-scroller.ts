import {
  computed,
  defineComponent,
  h,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  onUpdated,
  provide,
  reactive,
  ref,
  type CSSProperties,
  type InjectionKey,
  type PropType,
  type Ref,
  type VNodeRef,
} from "vue";

export type MessageScrollBehavior = "auto" | "instant" | "smooth";
export type MessageScrollPosition = "start" | "end";

export interface MessageScrollerContext {
  atEnd: Readonly<Ref<boolean>>;
  isScrollable: Readonly<Ref<boolean>>;
  scrollToEnd: (options?: { behavior?: MessageScrollBehavior }) => void;
  scrollToMessage: (
    id: string,
    options?: { behavior?: MessageScrollBehavior; block?: ScrollLogicalPosition },
  ) => void;
  viewport: Ref<HTMLElement | null>;
}

interface InternalMessageScrollerContext extends MessageScrollerContext {
  content: Ref<HTMLElement | null>;
  edgeThreshold: Ref<number>;
  following: Ref<boolean>;
  items: Map<string, HTMLElement>;
  previousItemPeek: Ref<number>;
  refresh: () => void;
}

const messageScrollerKey: InjectionKey<InternalMessageScrollerContext> =
  Symbol("ViteHubMessageScroller");

function useInternalMessageScroller(): InternalMessageScrollerContext {
  const context = inject(messageScrollerKey);
  if (!context)
    throw new Error("Message scroller primitives must be used inside MessageScrollerRoot.");
  return context;
}

export function useMessageScroller(): MessageScrollerContext {
  return useInternalMessageScroller();
}

function toNativeBehavior(value: MessageScrollBehavior | undefined): ScrollBehavior {
  return value === "instant" ? "auto" : (value ?? "smooth");
}

export function calculatePrependScrollTop(
  previousTop: number,
  previousHeight: number,
  nextHeight: number,
): number {
  return previousTop + (nextHeight - previousHeight);
}

export const MessageScrollerRoot = defineComponent({
  name: "MessageScrollerRoot",
  inheritAttrs: false,
  props: {
    as: { default: "div", type: String },
    autoScroll: { default: true, type: Boolean },
    defaultScrollPosition: { default: "end", type: String as PropType<MessageScrollPosition> },
    edgeThreshold: { default: 8, type: Number },
    previousItemPeek: { default: 64, type: Number },
  },
  setup(props, { attrs, slots }) {
    const viewport = ref<HTMLElement | null>(null);
    const content = ref<HTMLElement | null>(null);
    const atEnd = ref(props.defaultScrollPosition === "end");
    const following = ref(props.autoScroll && props.defaultScrollPosition === "end");
    const isScrollable = ref(false);
    const items = reactive(new Map<string, HTMLElement>());
    const refresh = () => {
      const node = viewport.value;
      if (!node) return;
      const distance = node.scrollHeight - node.clientHeight - node.scrollTop;
      atEnd.value = distance <= props.edgeThreshold;
      isScrollable.value = node.scrollHeight > node.clientHeight + 1;
    };
    const scrollToEnd = (options: { behavior?: MessageScrollBehavior } = {}) => {
      const node = viewport.value;
      if (!node) return;
      following.value = true;
      node.scrollTo({ behavior: toNativeBehavior(options.behavior), top: node.scrollHeight });
      nextTick(refresh);
    };
    const scrollToMessage = (
      id: string,
      options: { behavior?: MessageScrollBehavior; block?: ScrollLogicalPosition } = {},
    ) => {
      const item = items.get(id);
      if (!item) return;
      following.value = options.block === "end";
      item.scrollIntoView({
        behavior: toNativeBehavior(options.behavior),
        block: options.block ?? "start",
      });
      nextTick(refresh);
    };
    provide(messageScrollerKey, {
      atEnd,
      content,
      edgeThreshold: computed(() => props.edgeThreshold),
      following,
      isScrollable,
      items,
      previousItemPeek: computed(() => props.previousItemPeek),
      refresh,
      scrollToEnd,
      scrollToMessage,
      viewport,
    });
    return () =>
      h(
        props.as,
        { ...attrs, "data-slot": "message-scroller-root" },
        slots.default?.({
          atEnd: atEnd.value,
          isScrollable: isScrollable.value,
          scrollToEnd,
          scrollToMessage,
        }),
      );
  },
});

export const MessageScrollerViewport = defineComponent({
  name: "MessageScrollerViewport",
  inheritAttrs: false,
  props: { as: { default: "div", type: String } },
  setup(props, { attrs, slots }) {
    const context = useInternalMessageScroller();
    let resizeObserver: ResizeObserver | undefined;
    let mutationObserver: MutationObserver | undefined;
    const setViewport = (node: Element | null) => {
      context.viewport.value = node instanceof HTMLElement ? node : null;
    };
    const onScroll = () => {
      context.refresh();
      if (context.atEnd.value) context.following.value = true;
    };
    const interruptFollowing = () => {
      context.following.value = false;
    };
    const observeContent = () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      const viewport = context.viewport.value;
      if (viewport) resizeObserver?.observe(viewport);
      if (context.content.value && context.content.value !== viewport) {
        resizeObserver?.observe(context.content.value);
        mutationObserver?.observe(context.content.value, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      }
    };
    onMounted(() => {
      const viewport = context.viewport.value;
      if (!viewport) return;
      resizeObserver = new ResizeObserver(() => {
        context.refresh();
        if (context.following.value) context.scrollToEnd({ behavior: "instant" });
      });
      mutationObserver = new MutationObserver(() => {
        context.refresh();
        if (context.following.value) context.scrollToEnd({ behavior: "instant" });
      });
      observeContent();
      context.refresh();
      if (context.following.value) context.scrollToEnd({ behavior: "instant" });
    });
    onUpdated(() => {
      observeContent();
    });
    onBeforeUnmount(() => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      context.viewport.value = null;
    });
    return () =>
      h(
        props.as,
        {
          ...attrs,
          "data-at-end": context.atEnd.value ? "" : undefined,
          "data-slot": "message-scroller-viewport",
          onPointerdown: interruptFollowing,
          onScroll,
          onWheel: interruptFollowing,
          ref: setViewport as VNodeRef,
          style: [{ overflowAnchor: "none" } satisfies CSSProperties, attrs.style],
        },
        slots.default?.(),
      );
  },
});

export const MessageScrollerContent = defineComponent({
  name: "MessageScrollerContent",
  inheritAttrs: false,
  props: {
    as: { default: "div", type: String },
    items: { default: () => [], type: Array as PropType<readonly string[]> },
    preserveScrollOnPrepend: { default: true, type: Boolean },
  },
  setup(props, { attrs, slots }) {
    const context = useInternalMessageScroller();
    let previousFirst: string | undefined;
    let previousHeight = 0;
    let previousTop = 0;
    const setContent = (node: Element | null) => {
      context.content.value = node instanceof HTMLElement ? node : null;
    };
    onMounted(() => {
      previousFirst = props.items[0];
    });
    onUpdated(() => {
      const viewport = context.viewport.value;
      const first = props.items[0];
      if (
        props.preserveScrollOnPrepend &&
        viewport &&
        previousFirst &&
        first !== previousFirst &&
        !context.following.value
      ) {
        viewport.scrollTop = calculatePrependScrollTop(
          previousTop,
          previousHeight,
          viewport.scrollHeight,
        );
      }
      previousFirst = first;
      context.refresh();
    });
    return () => {
      const viewport = context.viewport.value;
      previousHeight = viewport?.scrollHeight ?? 0;
      previousTop = viewport?.scrollTop ?? 0;
      return h(
        props.as,
        { ...attrs, "data-slot": "message-scroller-content", ref: setContent as VNodeRef },
        slots.default?.(),
      );
    };
  },
});

export const MessageScrollerItem = defineComponent({
  name: "MessageScrollerItem",
  inheritAttrs: false,
  props: {
    as: { default: "div", type: String },
    messageId: { required: true, type: String },
    scrollAnchor: { default: false, type: Boolean },
  },
  setup(props, { attrs, slots }) {
    const context = useInternalMessageScroller();
    let element: HTMLElement | null = null;
    const setElement = (node: Element | null) => {
      if (element) context.items.delete(props.messageId);
      element = node instanceof HTMLElement ? node : null;
      if (element) context.items.set(props.messageId, element);
    };
    onMounted(() => {
      if (!props.scrollAnchor || !element) return;
      context.following.value = false;
      const viewport = context.viewport.value;
      if (viewport)
        viewport.scrollTop +=
          element.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top -
          context.previousItemPeek.value;
    });
    onBeforeUnmount(() => context.items.delete(props.messageId));
    return () =>
      h(
        props.as,
        {
          ...attrs,
          "data-message-id": props.messageId,
          "data-slot": "message-scroller-item",
          ref: setElement as VNodeRef,
          style: [{ overflowAnchor: "none" } satisfies CSSProperties, attrs.style],
        },
        slots.default?.(),
      );
  },
});

export const MessageScrollerButton = defineComponent({
  name: "MessageScrollerButton",
  inheritAttrs: false,
  props: {
    as: { default: "button", type: String },
    behavior: { default: "smooth", type: String as PropType<MessageScrollBehavior> },
  },
  setup(props, { attrs, slots }) {
    const context = useInternalMessageScroller();
    return () =>
      context.isScrollable.value && !context.atEnd.value
        ? h(
            props.as,
            {
              ...attrs,
              "aria-label": attrs["aria-label"] ?? "Scroll to latest message",
              "data-slot": "message-scroller-button",
              onClick: (event: MouseEvent) => {
                context.scrollToEnd({ behavior: props.behavior });
                if (typeof attrs.onClick === "function") attrs.onClick(event);
              },
              type: props.as === "button" ? "button" : undefined,
            },
            slots.default?.({ scrollToEnd: context.scrollToEnd }) ?? "↓",
          )
        : null;
  },
});
