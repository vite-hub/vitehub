import { type App, defineComponent, h, onBeforeUnmount, ref, Teleport, watch } from "vue";
import { icons } from "virtual:vitehub-ui-icons";

/**
 * Stand-ins for the three Nuxt UI components that the comment parts use, for a page without Nuxt UI, such as the
 * comments overlays in a shadow root. Register them with `registerStandaloneUI(app)`, and build with `standaloneUI()`
 * from `standalone/vite.ts`, which also turns the parts' own Nuxt UI imports into these. `standalone/styles.css` styles
 * them.
 */

/** The icons of the parts, as SVG elements built from path data. Nuxt UI's `UIcon` would bring its icon runtime. */
export const UIcon = defineComponent({
  name: "UIcon",
  inheritAttrs: false,
  props: { name: { default: "", type: String } },
  setup(props, { attrs }) {
    return () => {
      const parts = icons[props.name];
      if (!parts) return h("span", { ...attrs, "aria-hidden": "true", "data-slot": "standalone-icon" });
      // Elements, not markup: nothing here parses a string, so a Trusted Types policy has nothing to refuse.
      return h("svg", { ...attrs, "aria-hidden": "true", "data-slot": "standalone-icon", fill: "none", viewBox: "0 0 24 24" }, parts.map(([tag, shape]) => h(tag, shape)));
    };
  },
});

/** The part of Nuxt UI's `UButton` that the parts use: a label, an icon, a link, a color, a variant, a size, and a loading state. */
export const UButton = defineComponent({
  name: "UButton",
  inheritAttrs: false,
  props: {
    color: { default: "primary", type: String },
    disabled: { default: false, type: Boolean },
    icon: { type: String },
    label: { type: String },
    loading: { default: false, type: Boolean },
    size: { default: "md", type: String },
    square: { default: false, type: Boolean },
    to: { type: String },
    type: { default: "button", type: String },
    variant: { default: "solid", type: String },
  },
  setup(props, { attrs, slots }) {
    return () => {
      const shared = {
        ...attrs,
        "aria-busy": props.loading ? "true" : undefined,
        "data-color": props.color,
        "data-size": props.size,
        "data-square": props.square || (!props.label && !slots.default) ? "true" : undefined,
        "data-variant": props.variant,
        "data-standalone-button": "",
      };
      const content = [props.icon ? h(UIcon, { name: props.icon }) : null, props.label ? h("span", props.label) : null, slots.default?.()];
      // Nuxt UI renders a link for `to`. The parts pass `target` and `rel` with it.
      if (props.to) return h("a", { ...shared, href: props.to }, content);
      return h("button", { ...shared, disabled: props.disabled || props.loading, type: props.type }, content);
    };
  },
});

function modalRoot(trigger: HTMLElement): HTMLElement {
  const root = trigger.getRootNode();
  // SAFETY: Teleport inserts with `insertBefore`, which a shadow root has like an element.
  return root instanceof ShadowRoot ? root as unknown as HTMLElement : trigger.ownerDocument.body;
}

/**
 * The part of Nuxt UI's `UModal` that the image preview uses: the default slot opens it, and the `content` slot gets
 * `close`. It opens in the same root as its trigger, so it keeps the styles of a shadow root. Escape and a click
 * outside close it, and the focus goes back to the trigger.
 */
export const UModal = defineComponent({
  name: "UModal",
  inheritAttrs: false,
  props: {
    title: { type: String },
    ui: { default: () => ({}), type: Object },
  },
  setup(props, { slots }) {
    const open = ref(false);
    const trigger = ref<HTMLElement | null>(null);
    const dialog = ref<HTMLElement | null>(null);
    const close = () => {
      open.value = false;
      trigger.value?.querySelector<HTMLElement>("button, a")?.focus();
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !open.value) return;
      event.stopPropagation();
      close();
    };
    watch(open, (value) => {
      if (value) requestAnimationFrame(() => dialog.value?.focus());
    });
    onBeforeUnmount(() => {
      open.value = false;
    });
    return () => {
      const ui = props.ui as { overlay?: string, content?: string };
      return [
        h("span", { "data-slot": "standalone-modal-trigger", onClick: () => (open.value = true), ref: trigger }, slots.default?.()),
        open.value && trigger.value
          // A shadow root keeps the dialog next to its styles. Vue inserts into it as into an element.
          ? h(Teleport, { to: modalRoot(trigger.value) },
              h("div", { class: ui.overlay, "data-slot": "standalone-modal", onClick: (event: MouseEvent) => event.target === event.currentTarget && close() },
                h("div", { "aria-label": props.title, "aria-modal": "true", class: ui.content, onKeydown, ref: dialog, role: "dialog", tabindex: -1 }, slots.content?.({ close }))))
          : null,
      ];
    };
  },
});

/**
 * Registers the stand-ins on `app`, so the parts render them at once instead of loading their Nuxt UI imports on first
 * render.
 */
export function registerStandaloneUI(app: App): void {
  app.component("UButton", UButton);
  app.component("UIcon", UIcon);
  app.component("UModal", UModal);
}
