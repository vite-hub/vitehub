import {
  computed,
  defineComponent,
  getCurrentInstance,
  h,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type Component,
  type PropType,
  type SlotsType,
  type VNode,
} from "vue";
import { hasRuntimeType } from "../internal/runtime-type.ts";
import { PrimitiveIcon, type PrimitiveIconName } from "./primitive-icon.ts";

/** Props of every rail slot. `expanded` is true while the rail shows its labels, for example to turn off tooltips. */
export interface PrimitiveRailSlotProps {
  expanded: boolean;
}

type PrimitiveRailSlot = (props: PrimitiveRailSlotProps) => VNode[];

// A pointer that only crosses the rail does not open it.
const hoverIntentDelay = 140;

/**
 * The narrow icon rail that ViteHub docs and the Console show at the left edge.
 * It always takes 3.5rem of the layout. On hover or keyboard focus, its surface expands over the next element to show the labels.
 */
export const PrimitiveRail = defineComponent({
  name: "PrimitiveRail",
  props: {
    /** Accessible name of the navigation landmark. */
    label: { required: true, type: String },
  },
  // SAFETY: Vue uses Object as its runtime slots marker. Each slot receives the shared expanded boolean.
  slots: Object as SlotsType<{ default?: PrimitiveRailSlot; footer?: PrimitiveRailSlot; header?: PrimitiveRailSlot }>,
  setup(props, { slots }) {
    const hovered = ref(false);
    const focused = ref(false);
    const dismissed = ref(false);
    const root = ref<HTMLElement>();
    const expanded = computed(() => (hovered.value || focused.value) && !dismissed.value);
    let intent: ReturnType<typeof setTimeout> | undefined;

    const cancelIntent = () => {
      clearTimeout(intent);
      intent = undefined;
    };
    // Escape keeps the rail closed until the pointer and the keyboard focus have both left it.
    const release = () => {
      if (!hovered.value && !focused.value) dismissed.value = false;
    };

    function onPointerenter(event: PointerEvent): void {
      // Touch has no hover, so a tap never opens the rail. A coarse pointer keeps the compact rail.
      if (event.pointerType === "touch" || !globalThis.matchMedia?.("(hover: hover) and (pointer: fine)").matches) return;
      cancelIntent();
      intent = setTimeout(() => {
        intent = undefined;
        hovered.value = true;
      }, hoverIntentDelay);
    }

    function onPointerleave(): void {
      cancelIntent();
      hovered.value = false;
      release();
    }

    // A menu trigger closes the rail first, so the menu opens next to the icon and does not move with the row.
    function dismissForMenu(event: Event): void {
      if (!(event.target instanceof Element) || !root.value?.contains(event.target) || !event.target.closest("[aria-haspopup]")) return;
      cancelIntent();
      dismissed.value = true;
    }

    // Only keyboard focus opens the rail. A click also focuses the item, but it must not hold the rail open.
    function onFocusin(event: FocusEvent): void {
      focused.value = event.target instanceof Element && event.target.matches(":focus-visible");
    }

    function onFocusout(event: FocusEvent): void {
      const rail = event.currentTarget;
      if (rail instanceof Element && event.relatedTarget instanceof Node && rail.contains(event.relatedTarget)) return;
      focused.value = false;
      release();
    }

    // The document listens, so Escape also closes a rail that the pointer opened while focus is elsewhere.
    // The event continues to the page, so shortcuts that also use Escape still run.
    function onKeydown(event: KeyboardEvent): void {
      if (["Enter", " ", "ArrowDown"].includes(event.key)) dismissForMenu(event);
      else if (event.key === "Escape" && expanded.value) {
        cancelIntent();
        dismissed.value = true;
      }
    }

    onMounted(() => document.addEventListener("keydown", onKeydown));
    onBeforeUnmount(() => {
      cancelIntent();
      document.removeEventListener("keydown", onKeydown);
    });

    return () => {
      const slotProps: PrimitiveRailSlotProps = { expanded: expanded.value };
      return h(
        "nav",
        {
          "aria-label": props.label,
          class: "vh-primitive-rail",
          // A deliberate close by Escape or a menu trigger skips the width transition, so a menu anchors to a still icon.
          "data-dismissed": dismissed.value ? "" : undefined,
          "data-expanded": expanded.value ? "" : undefined,
          onFocusin,
          onFocusout,
          onPointerdown: dismissForMenu,
          onPointerenter,
          onPointerleave,
          ref: root,
        },
        h("div", { class: "vh-primitive-rail__surface" }, [
          slots.header ? h("div", { class: "vh-primitive-rail__header" }, slots.header(slotProps)) : null,
          h("div", { class: "vh-primitive-rail__body" }, slots.default?.(slotProps)),
          slots.footer ? h("div", { class: "vh-primitive-rail__footer" }, slots.footer(slotProps)) : null,
        ]),
      );
    };
  },
});

/**
 * Scrolls the rail body the least amount that shows the whole item, with no animation.
 * It changes only the rail's own scroll position, never the page scroll.
 */
function revealInRail(item: Element): void {
  const body = item.closest(".vh-primitive-rail__body");
  if (!body) return;
  const itemBox = item.getBoundingClientRect();
  const bodyBox = body.getBoundingClientRect();
  if (itemBox.top < bodyBox.top) body.scrollTop -= bodyBox.top - itemBox.top;
  else if (itemBox.bottom > bodyBox.bottom) body.scrollTop += itemBox.bottom - bodyBox.bottom;
}

/** A group of rail items. A short rule separates consecutive groups. */
export const PrimitiveRailGroup = defineComponent({
  name: "PrimitiveRailGroup",
  setup(_props, { slots }) {
    return () => h("div", { class: "vh-primitive-rail__group" }, slots.default?.());
  },
});

/**
 * One rail target: a square icon that becomes a labeled row when the rail expands. It renders a button by default.
 * Pass a link component in `as` and its props, such as `to`, as attributes.
 * The default slot replaces the primitive icon, for example with a host icon component. The icon is decorative.
 */
export const PrimitiveRailItem = defineComponent({
  name: "PrimitiveRailItem",
  props: {
    as: {
      default: "button",
      // SAFETY: Vue's runtime constructors are paired with the element name or component union.
      type: [String, Object, Function] as PropType<string | Component>,
    },
    /** Marks the item as the current page with `aria-current="page"`. */
    current: Boolean,
    icon: {
      required: false,
      // SAFETY: Vue's runtime String constructor is paired with the closed icon name union.
      type: String as PropType<PrimitiveIconName>,
    },
    /** Visible label and accessible name. The label shows when the rail expands. */
    label: { required: true, type: String },
  },
  setup(props, { slots }) {
    // A long rail can hide the current item below the fold. Show it after a direct visit and after each change.
    const instance = getCurrentInstance();
    const revealIfCurrent = () => {
      const element: unknown = instance?.proxy?.$el;
      if (props.current && hasRuntimeType(globalThis.Element, "function") && element instanceof Element) revealInRail(element);
    };
    onMounted(revealIfCurrent);
    watch(() => props.current, revealIfCurrent, { flush: "post" });

    const content = () => [
      h("span", { "aria-hidden": "true", class: "vh-primitive-rail__icon" }, slots.default?.() ?? (props.icon ? [h(PrimitiveIcon, { name: props.icon })] : [])),
      h("span", { class: "vh-primitive-rail__label" }, props.label),
    ];
    return () => {
      const attributes = {
        "aria-current": props.current ? "page" : undefined,
        "aria-label": props.label,
        class: "vh-primitive-rail__item",
      };
      return hasRuntimeType(props.as, "string")
        ? h(props.as, { ...attributes, type: props.as === "button" ? "button" : undefined }, content())
        : h(props.as, attributes, { default: content });
    };
  },
});
