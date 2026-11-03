import { defineComponent, h, onBeforeUnmount, onMounted, type PropType, ref, useId } from "vue";
import { icon } from "./icons.ts";

export type UnsupportedBrowser = "safari" | "unknown";

/** Safari, including every browser on iOS, which all use WebKit. */
export function detectUnsupportedBrowser(userAgent: string): UnsupportedBrowser {
  const webkitOnly = /Safari\//.test(userAgent) && !/(Chrome|Chromium|Edg|OPR|Firefox)\//.test(userAgent);
  const ios = /(iPhone|iPad|iPod)/.test(userAgent);
  return webkitOnly || ios ? "safari" : "unknown";
}

/**
 * Tells the reader that the live workspace cannot run, and that the page still works as text.
 * It renders only on the client, after the support check, so a supported browser never sees it flash.
 * It is an inline banner, not a tooltip, because touch devices have no hover and it holds buttons.
 */
export const BrowserSupportNotice = defineComponent({
  name: "BrowserSupportNotice",
  props: {
    /** The support result, such as `workspace.support.value?.supported`. The notice shows only when it is `false`. */
    supported: { default: undefined, type: Boolean as PropType<boolean | undefined> },
    /** Pass the support check's reason to distinguish page configuration from browser limitations. */
    reason: { default: undefined, type: String },
    /** Overrides the browser that the notice names. Detected from the user agent by default. */
    browser: { default: undefined, type: String as PropType<UnsupportedBrowser> },
    /** The link that Copy link copies. Defaults to the current page. */
    url: { default: undefined, type: String },
  },
  emits: {
    copied: (url: string) => typeof url === "string",
  },
  setup(props, { emit }) {
    const mounted = ref(false);
    const detected = ref<UnsupportedBrowser>("unknown");
    const why = ref(false);
    const copied = ref(false);
    const whyId = useId();
    const root = ref<HTMLElement | null>(null);

    function closeOnOutside(event: PointerEvent) {
      if (why.value && root.value && event.target instanceof Node && !root.value.contains(event.target)) why.value = false;
    }
    onMounted(() => {
      mounted.value = true;
      detected.value = detectUnsupportedBrowser(navigator.userAgent);
      document.addEventListener("pointerdown", closeOnOutside);
    });
    onBeforeUnmount(() => document.removeEventListener("pointerdown", closeOnOutside));

    async function copy() {
      const url = props.url ?? location.href;
      try {
        await navigator.clipboard.writeText(url);
        copied.value = true;
        setTimeout(() => { copied.value = false; }, 2000);
        emit("copied", url);
      }
      catch {
        // Some browsers block the clipboard. The link is still in the address bar.
      }
    }

    return () => {
      if (!mounted.value || props.supported !== false) return null;
      const browser = props.browser ?? detected.value;
      const isolation = props.reason?.includes("not cross-origin isolated") === true;
      return h("aside", { "aria-labelledby": `${whyId}-title`, class: "vh-ws-support", ref: root }, [
        icon("monitor", "vh-ws-icon vh-ws-support-icon"),
        h("div", { class: "vh-ws-support-text" }, [
          h("p", { class: "vh-ws-support-title", id: `${whyId}-title` }, isolation ? "This page needs workspace setup" : browser === "safari" ? "The live workspace does not run in Safari" : "The live workspace does not run in this browser"),
          h("p", { class: "vh-ws-muted" }, isolation
            ? "This tutorial still works as text. The site owner needs to enable cross-origin isolation for the live workspace."
            : "This tutorial still works as text. To edit and run the code next to each step, open this page in Chrome, Edge, or Firefox on a desktop."),
          h("div", { class: "vh-ws-actions" }, [
            h("button", { class: "vh-ws-button", type: "button", onClick: copy }, [icon(copied.value ? "check" : "copy"), copied.value ? "Copied" : "Copy link"]),
            h("div", { class: "vh-ws-popover-anchor" }, [
              h("button", {
                "aria-controls": whyId,
                "aria-expanded": why.value ? "true" : "false",
                class: "vh-ws-button",
                type: "button",
                onClick: () => { why.value = !why.value; },
                onKeydown: (event: KeyboardEvent) => { if (event.key === "Escape") why.value = false; },
              }, "Why?"),
              why.value
                ? h("p", { class: "vh-ws-popover", id: whyId, role: "note" }, isolation ? props.reason : browser === "safari"
                    ? "Safari does not support the browser isolation that WebContainers need to run Node.js in a tab."
                    : "This browser does not support the browser isolation that WebContainers need to run Node.js in a tab.")
                : undefined,
            ]),
          ]),
        ]),
      ]);
    };
  },
});
