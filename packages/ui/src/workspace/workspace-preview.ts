import { computed, defineComponent, h, ref, useId, watch } from "vue";
import { useUIComponent } from "../internal/nuxt-ui.ts";
import { icon } from "./icons.ts";

function join(base: string, path: string) {
  try {
    return new URL(path || "/", base).href;
  }
  catch {
    return base;
  }
}

/**
 * The preview of the dev server, in an iframe with a path bar.
 * The page cannot `fetch()` the WebContainer preview origin, so an iframe is the only way to show it.
 */
export const WorkspacePreview = defineComponent({
  name: "WorkspacePreview",
  props: {
    /** The preview URL, such as `workspace.previewUrl`. Unset until the dev server is ready. */
    url: { default: undefined, type: String },
    /** The path in the path bar. Use `v-model:path`. */
    path: { default: "/", type: String },
    title: { default: "App preview", type: String },
  },
  emits: {
    "update:path": (path: string) => typeof path === "string",
  },
  setup(props, { emit, expose, slots }) {
    const inputId = useId();
    const UInput = useUIComponent("UInput");
    const draft = ref(props.path);
    const reloads = ref(0);
    watch(() => props.path, (path) => { draft.value = path; });
    const src = computed(() => props.url ? join(props.url, props.path) : undefined);

    function go() {
      const path = draft.value.startsWith("/") ? draft.value : `/${draft.value}`;
      draft.value = path;
      if (path === props.path) reloads.value++;
      else emit("update:path", path);
    }
    const reload = () => { reloads.value++; };
    expose({ reload });

    return () => h("div", { class: "vh-ws-preview" }, [
      h("form", {
        class: "vh-ws-preview-bar",
        onSubmit(event: Event) {
          event.preventDefault();
          go();
        },
      }, [
        h("button", { "aria-label": "Reload preview", class: "vh-ws-icon-button", disabled: !src.value, title: "Reload", type: "button", onClick: reload }, [icon("rotate-cw")]),
        h("label", { class: "vh-ws-sr-only", for: inputId }, "Preview path"),
        h(UInput, {
          autocapitalize: "off",
          autocomplete: "off",
          class: "vh-ws-preview-path",
          disabled: !src.value,
          id: inputId,
          modelValue: draft.value,
          spellcheck: false,
          "onUpdate:modelValue": (value: string | number) => { draft.value = String(value); },
        }),
        h("a", {
          "aria-disabled": src.value ? undefined : "true",
          "aria-label": "Open preview in a new tab",
          class: "vh-ws-icon-button",
          href: src.value,
          rel: "noopener",
          target: "_blank",
          title: "Open in new tab",
        }, [icon("external-link")]),
      ]),
      src.value
        ? h("iframe", {
            // Reload by mounting a new frame. The page cannot reach into the cross-origin frame to call `location.reload()`.
            allow: "cross-origin-isolated; clipboard-read; clipboard-write",
            class: "vh-ws-preview-frame",
            key: `${src.value}#${reloads.value}`,
            src: src.value,
            title: props.title,
          })
        : h("div", { class: "vh-ws-empty" }, slots.empty?.() ?? [
            h("p", { class: "vh-ws-empty-title" }, "No preview yet"),
            h("p", { class: "vh-ws-muted" }, "The preview opens here when the dev server is ready."),
          ]),
    ]);
  },
});
