import { computed, defineComponent, h, onBeforeUnmount, onBeforeUpdate, onMounted, onUpdated, type PropType, ref } from "vue";
import { RollNumber } from "../components/motion.ts";
import { useViteHubUIIcons } from "../config.ts";
import { createMotionList, type MotionList } from "../motion/list.ts";
import { travel } from "../motion/helpers/travel.ts";
import { ImagePreview } from "./image-preview.ts";
import { useUIComponent } from "./nuxt-ui.ts";

/** A picture in a comment box: the key that `remove` gives back, its file name, and its preview URL. */
export interface CommentStackImage {
  key: string;
  name: string;
  url: string;
}

// How long the fan stays open after the pointer leaves it, so a pointer that slips off a card doesn't close it.
const closeDelay = 250;
// The size of a card in the fan and the space between two cards, in rem. The fan squeezes the cards together when the
// box is too narrow for them side by side.
const fanCard = 3.5;
const fanGap = 0.375;

/**
 * The pictures of a comment box as one stack of cards beside the text, with their count. Hover or focus fans them out
 * above the box, where each card opens full size and has its Remove button. A tap on the stack fans it out too.
 *
 * A new picture comes out of `origin`, such as the text for a paste or the attach button for a pick, and the others
 * move to make room (docs/design/motion.md, "Items are added, removed, or reordered"). The fan travels each card from
 * its place in the stack to its place in the fan and back ("Something moves to a new place").
 */
export const CommentImageStack = defineComponent({
  name: "CommentImageStack",
  props: {
    images: { required: true, type: Array as PropType<readonly CommentStackImage[]> },
    /** The pictures can't be removed, such as while the comment is sent. */
    disabled: { default: false, type: Boolean },
    /** Where the next new picture comes from. Read once for each change of `images`. */
    origin: { type: Function as PropType<() => Element | null | undefined> },
  },
  emits: ["remove"],
  setup(props, { emit }) {
    const icons = useViteHubUIIcons();
    const UButton = useUIComponent("UButton");
    const root = ref<HTMLElement>();
    const cards = ref<HTMLElement>();
    const fanned = ref(false);
    const step = ref(fanCard + fanGap);
    let list: MotionList | undefined;
    let closer: ReturnType<typeof setTimeout> | undefined;
    // The pointer opened the fan, so a click on the stack under it keeps the fan open instead of folding it.
    let hovered = false;
    // Esc gives the focus back to the toggle, which must not fan the cards out again.
    let refocus = false;
    // The places of the cards before the fan opens or closes. The update after that travels each card from it.
    let fanFrom: Map<HTMLElement, DOMRect> | undefined;

    const cardElements = () => [...(cards.value?.children ?? [])].filter((child): child is HTMLElement => child instanceof HTMLElement && child.hasAttribute("data-key"));
    function setFanned(value: boolean) {
      clearTimeout(closer);
      if (value && props.images.length === 0) value = false;
      if (fanned.value === value) return;
      fanFrom = new Map(cardElements().map((card) => [card, card.getBoundingClientRect()]));
      if (value) {
        const box = root.value?.closest("[data-slot=comment-composer-box]") ?? root.value?.parentElement;
        const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const room = (box?.clientWidth ?? 0) / rem - 0.5;
        const count = props.images.length;
        step.value = count > 1 ? Math.max(1, Math.min(fanCard + fanGap, (room - fanCard) / (count - 1))) : fanCard + fanGap;
      }
      fanned.value = value;
    }
    const closeSoon = () => {
      clearTimeout(closer);
      closer = setTimeout(() => setFanned(false), closeDelay);
    };

    onMounted(() => {
      if (cards.value) list = createMotionList(cards.value);
    });
    onBeforeUpdate(() => {
      if (!fanFrom) list?.measure();
    });
    onUpdated(() => {
      if (props.images.length === 0 && fanned.value) setFanned(false);
      const from = fanFrom;
      fanFrom = undefined;
      if (!from) return list?.play({ origin: props.origin?.() ?? undefined });
      for (const [card, box] of from) if (card.isConnected) void travel(card, { from: box });
    });
    onBeforeUnmount(() => {
      clearTimeout(closer);
      list?.destroy();
    });

    const label = computed(() => (props.images.length === 1 ? "1 picture" : `${props.images.length} pictures`));

    return () => {
      const count = props.images.length;
      return h(
        "div",
        {
          "data-fanned": fanned.value ? "true" : undefined,
          "data-slot": "comment-image-stack",
          // Only the keyboard fans out on focus: a click focuses the toggle too, and the click fans out itself.
          onFocusin: (event: FocusEvent) => {
            if (refocus) return;
            if (event.target instanceof Element && event.target.matches(":focus-visible")) setFanned(true);
          },
          onFocusout: (event: FocusEvent) => {
            if (!(event.relatedTarget instanceof Node) || !root.value?.contains(event.relatedTarget)) closeSoon();
          },
          // Esc folds the fan first, and leaves the box and its text alone.
          onKeydown: (event: KeyboardEvent) => {
            if (event.key !== "Escape" || !fanned.value) return;
            event.preventDefault();
            event.stopPropagation();
            setFanned(false);
            refocus = true;
            root.value?.querySelector<HTMLElement>("[data-slot=comment-image-stack-toggle]")?.focus();
            refocus = false;
          },
          onPointerenter: (event: PointerEvent) => {
            if (event.pointerType !== "mouse") return;
            hovered = true;
            setFanned(true);
          },
          onPointerleave: (event: PointerEvent) => {
            if (event.pointerType !== "mouse") return;
            hovered = false;
            closeSoon();
          },
          ref: root,
          role: "group",
          "aria-label": `Attached ${label.value}`,
          style: { "--vh-stack-step": `${step.value}rem` },
        },
        [
          h(
            "div",
            { "data-slot": "comment-image-stack-cards", ref: cards },
            props.images.map((image, index) =>
              h(
                "div",
                {
                  "data-key": image.key,
                  "data-slot": "comment-image-stack-card",
                  // The stack hides the cards behind the toggle, so a click on it fans them out instead of opening one.
                  inert: fanned.value ? undefined : true,
                  key: image.key,
                  style: { "--vh-stack-depth": count - 1 - index, "--vh-stack-index": index },
                },
                [
                  h(ImagePreview, { alt: image.name, compact: true, src: image.url }),
                  h(UButton, {
                    "aria-label": `Remove ${image.name}`,
                    color: "neutral",
                    "data-slot": "comment-image-stack-remove",
                    disabled: props.disabled,
                    icon: icons.value.close,
                    onClick: () => emit("remove", image.key),
                    size: "xs",
                    square: true,
                    variant: "ghost",
                  }),
                ],
              ),
            ),
          ),
          h("button", {
            "aria-expanded": String(fanned.value),
            "aria-label": `Show ${label.value}`,
            "data-slot": "comment-image-stack-toggle",
            onClick: () => setFanned(hovered || !fanned.value),
            type: "button",
          }),
          count > 1 ? h(RollNumber, { "aria-hidden": "true", "data-slot": "comment-image-stack-count", value: count }) : null,
        ],
      );
    };
  },
});
