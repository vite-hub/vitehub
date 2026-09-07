import { computed, defineComponent, h, ref, resolveComponent, watch } from "vue";

function isImageUrl(value: string): boolean {
  if (!value) return false;
  if (/^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(value) || value.startsWith("blob:")) return true;
  try {
    const url = new URL(value, "https://vitehub.invalid");
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export const ImagePreview = defineComponent({
  name: "ImagePreview",
  inheritAttrs: false,
  props: {
    alt: { default: "", type: String },
    compact: { default: false, type: Boolean },
    src: { default: "", type: String },
    title: { type: String },
  },
  setup(props) {
    const failed = ref(false);
    const label = computed(() => props.alt || props.title || "Image");
    const UModal = resolveComponent("UModal");
    const UButton = resolveComponent("UButton");
    watch(() => props.src, () => { failed.value = false; });

    return () => {
      if (!isImageUrl(props.src)) return h("span", { class: "vh-image-unavailable" }, label.value);
      return h(UModal, {
        title: label.value,
        transition: false,
        ui: {
          overlay: "vh-image-overlay",
          content: "vh-image-dialog",
        },
      }, {
        default: () => h("button", {
          "aria-label": `Preview ${label.value}`,
          class: ["vh-image-preview", props.compact && "vh-image-preview--compact"],
          title: props.title || label.value,
          type: "button",
        }, failed.value
          ? h("span", { class: "vh-image-unavailable" }, "Image unavailable")
          : h("img", {
              alt: label.value,
              loading: "lazy",
              onError: () => { failed.value = true; },
              src: props.src,
            })),
        content: ({ close }: { close: () => void }) => [
          h("div", { class: "vh-image-dialog__toolbar" }, [
            h("span", { class: "vh-image-dialog__name", title: label.value }, label.value),
            h(UButton, {
              "aria-label": "Open original image",
              class: "vh-image-dialog__action",
              color: "neutral",
              icon: "i-ph-arrow-square-out-light",
              external: true,
              to: props.src,
              target: "_blank",
              rel: "noreferrer",
              variant: "ghost",
            }),
            h(UButton, {
              "aria-label": "Close image preview",
              class: "vh-image-dialog__action",
              color: "neutral",
              icon: "i-ph-x-light",
              onClick: close,
              variant: "ghost",
            }),
          ]),
          failed.value
            ? h("p", { class: "vh-image-dialog__error", role: "status" }, "Image unavailable. The file may have been moved or deleted.")
            : h("img", {
                alt: label.value,
                class: "vh-image-dialog__image",
                onError: () => { failed.value = true; },
                src: props.src,
              }),
        ],
      });
    };
  },
});
