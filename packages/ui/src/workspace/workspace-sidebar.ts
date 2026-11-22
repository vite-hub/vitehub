import { defineComponent, h, nextTick, onBeforeUnmount, onMounted, type PropType, ref, type SlotsType, useId, type VNode, watch } from "vue";
import { useUIComponent } from "../internal/nuxt-ui.ts";
import { ring } from "../motion/helpers/ring.ts";

/** An action at the bottom of the sidebar. */
export type WorkspaceSidebarAction = "reset" | "download" | "copy-link";

const tabbable = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * A panel that opens over the workspace from the sidebar button of `WorkspaceBar`, under the bar. It does not push the
 * workspace. Focus moves into it when it opens and back to the button when it closes. Escape and a click outside close
 * it. Reset, Download and Copy link sit at the bottom. Put it in the box of the bar, such as the `bar` slot of
 * `WorkspaceShell`.
 */
export const WorkspaceSidebar = defineComponent({
  name: "WorkspaceSidebar",
  props: {
    /** Whether the sidebar is open. Use `v-model:open`. */
    open: { default: false, type: Boolean },
    /** The id of the panel. Give the same one to `sidebar-id` of `WorkspaceBar`. */
    id: { default: undefined, type: String },
    /** The name of the panel for screen readers. */
    label: { default: "Sidebar", type: String },
    /** The buttons at the bottom, in this order. */
    actions: { default: () => ["reset", "download", "copy-link"], type: Array as PropType<readonly WorkspaceSidebarAction[]> },
    /** Set it to `true` for a moment after the link is copied. The button then says so and rings. */
    copied: { default: false, type: Boolean },
  },
  emits: {
    "update:open": (open: boolean) => typeof open === "boolean",
    reset: () => true,
    download: () => true,
    "copy-link": () => true,
  },
  slots: Object as SlotsType<{ default?: () => VNode[], footer?: () => VNode[] }>,
  setup(props, { emit, slots }) {
    const UButton = useUIComponent("UButton");
    const fallbackId = useId();
    const id = () => props.id ?? fallbackId;
    const panel = ref<HTMLElement>();
    const copyButton = ref<{ $el?: Element } | HTMLElement>();
    let previous: HTMLElement | undefined;

    function enter() {
      const active = document.activeElement;
      previous = active instanceof HTMLElement ? active : undefined;
      void nextTick(() => {
        const first = panel.value?.querySelector<HTMLElement>(tabbable);
        (first ?? panel.value)?.focus();
      });
    }

    watch(() => props.open, (open) => {
      if (open) return enter();
      const active = document.activeElement;
      // Focus goes back only when it was in the panel. After a click outside, it stays where the reader clicked.
      const inside = !active || active === document.body || !!panel.value?.contains(active);
      // A sidebar that mounted open has no earlier focus to restore, so focus goes to the button that controls it.
      const target = previous?.isConnected && previous !== document.body
        ? previous
        : document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(id())}"]`);
      if (inside) target?.focus();
      previous = undefined;
    }, { flush: "pre" });

    watch(() => props.copied, (copied) => {
      const target = copyButton.value instanceof HTMLElement ? copyButton.value : copyButton.value?.$el;
      if (copied && target instanceof HTMLElement) ring(target);
    });

    function outside(event: PointerEvent) {
      if (!props.open) return;
      const path = event.composedPath();
      if (panel.value && path.includes(panel.value)) return;
      if (path.some(node => node instanceof Element && node.getAttribute("aria-controls") === id())) return;
      emit("update:open", false);
    }
    onMounted(() => {
      document.addEventListener("pointerdown", outside, true);
      // A sidebar that mounts open takes focus too. The watcher above runs only on a change.
      if (props.open) enter();
    });
    onBeforeUnmount(() => document.removeEventListener("pointerdown", outside, true));

    const button = (action: WorkspaceSidebarAction) => {
      const shared = { class: "vh-ws-sidebar-action", color: "neutral", key: action, variant: "ghost" };
      if (action === "reset") return h(UButton, { ...shared, icon: "i-lucide-rotate-ccw", label: "Reset", onClick: () => emit("reset") });
      if (action === "download") return h(UButton, { ...shared, icon: "i-lucide-download", label: "Download", onClick: () => emit("download") });
      return h(UButton, {
        ...shared,
        icon: props.copied ? "i-lucide-check" : "i-lucide-link",
        label: props.copied ? "Link copied" : "Copy link",
        ref: copyButton,
        onClick: () => emit("copy-link"),
      });
    };

    return () => {
      const footer = slots.footer?.() ?? (props.actions.length ? props.actions.map(button) : undefined);
      return h("aside", {
        "aria-label": props.label,
        class: "vh-ws-sidebar",
        "data-open": props.open ? "" : undefined,
        id: id(),
        inert: !props.open,
        ref: panel,
        tabindex: -1,
        onKeydown: (event: KeyboardEvent) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          emit("update:open", false);
        },
      }, [
        h("div", { class: "vh-ws-sidebar-body" }, slots.default?.()),
        footer ? h("div", { class: "vh-ws-sidebar-footer" }, footer) : undefined,
      ]);
    };
  },
});
