import { computed, defineComponent, h, nextTick, onBeforeUnmount, type PropType, ref } from "vue";
import { RollNumber } from "../components/motion.ts";
import { useViteHubUIIcons } from "../config.ts";
import { type Travel, type TravelBox, travel } from "../motion/helpers/travel.ts";
import { useUIComponent } from "./nuxt-ui.ts";

/** A picture of a message: its key, its name, and its URL. */
export interface GalleryImage {
  key: string;
  name: string;
  src: string;
}

// A message shows up to four tiles. The fourth says how many more there are, and the preview steps through all of them.
const tileCount = 4;

/** The box of `width` by `height` that covers `box`, centered on it: the picture with the shape it has full size. */
function cover(box: DOMRect, width: number, height: number): TravelBox {
  if (!width || !height || !box.width || !box.height) return box;
  const scale = Math.max(box.width / width, box.height / height);
  const w = width * scale;
  const h = height * scale;
  return { left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2, width: w, height: h };
}

/**
 * The pictures of a comment as a mosaic: one keeps its own shape, two split the width, three put the first beside the
 * other two, and four or more show a grid of four whose last tile says how many more. A click opens the picture full
 * size, travelling from its tile, and the arrow keys and buttons step through every picture of the message. Closing
 * sends the picture back to its tile (docs/design/motion.md, "Something moves to a new place: a picture that zooms").
 */
export const ImageGallery = defineComponent({
  name: "ImageGallery",
  props: {
    images: { required: true, type: Array as PropType<readonly GalleryImage[]> },
  },
  setup(props) {
    const UModal = useUIComponent("UModal");
    const UButton = useUIComponent("UButton");
    const icons = useViteHubUIIcons();
    const current = ref<number | null>(null);
    const closing = ref(false);
    const failed = ref(new Set<string>());
    const tiles: HTMLElement[] = [];
    const picture = ref<HTMLImageElement | null>(null);
    let flight: Travel | undefined;

    const tileOf = (index: number) => tiles[Math.min(index, tileCount - 1)];
    const shown = computed(() => (current.value === null ? undefined : props.images[current.value]));

    // The picture lays out full size first, then travels from its tile. It waits for its size when it isn't loaded yet.
    async function flyIn(index: number) {
      await nextTick();
      const image = picture.value;
      const tile = tileOf(index);
      if (!image || !tile || current.value !== index) return;
      if (!image.complete) await new Promise((resolve) => image.addEventListener("load", resolve, { once: true }));
      if (current.value !== index || !image.isConnected) return;
      flight = travel(image, { from: cover(tile.getBoundingClientRect(), image.offsetWidth, image.offsetHeight) });
    }
    function open(index: number) {
      flight?.stop();
      closing.value = false;
      current.value = index;
      void flyIn(index);
    }
    async function close() {
      if (current.value === null || closing.value) return;
      const image = picture.value;
      const tile = tileOf(current.value);
      closing.value = true;
      if (image && tile && image.complete && image.naturalWidth) {
        flight = travel(image, { to: cover(tile.getBoundingClientRect(), image.offsetWidth, image.offsetHeight) });
        await flight.done;
      }
      flight?.stop();
      if (!closing.value) return;
      closing.value = false;
      current.value = null;
    }
    function go(step: number) {
      if (current.value === null || closing.value || props.images.length < 2) return;
      flight?.stop();
      current.value = (current.value + step + props.images.length) % props.images.length;
    }
    onBeforeUnmount(() => flight?.stop());

    return () => {
      const count = props.images.length;
      tiles.length = 0;
      const many = count > 1;
      return h("div", { "data-count": Math.min(count, tileCount), "data-slot": "comment-reply-images" }, [
        ...props.images.slice(0, tileCount).map((image, index) =>
          h(
            "button",
            {
              "aria-label": `Preview ${image.name}`,
              // The tile of the open picture is empty, because the picture is out of it.
              "data-open": current.value !== null && Math.min(current.value, tileCount - 1) === index ? "true" : undefined,
              "data-slot": "comment-reply-image",
              key: image.key,
              onClick: () => open(index),
              ref: (element: unknown) => {
                if (element instanceof HTMLElement) tiles[index] = element;
              },
              title: image.name,
              type: "button",
            },
            [
              failed.value.has(image.key)
                ? h("span", { class: "vh-image-unavailable" }, "Image unavailable")
                : h("img", {
                    alt: "",
                    loading: "lazy",
                    onError: () => (failed.value = new Set(failed.value).add(image.key)),
                    src: image.src,
                  }),
              index === tileCount - 1 && count > tileCount
                ? h("span", { "aria-hidden": "true", "data-slot": "comment-reply-image-more" }, `+${count - tileCount + 1}`)
                : null,
            ],
          ),
        ),
        h(
          UModal,
          {
            open: current.value !== null,
            title: shown.value?.name ?? "Image",
            transition: false,
            ui: {
              content: "vh-image-dialog vh-image-gallery",
              overlay: closing.value ? "vh-image-overlay vh-image-overlay--closing" : "vh-image-overlay",
            },
            "onUpdate:open": (value: boolean) => {
              if (!value) void close();
            },
          },
          {
            // The arrow keys step through the pictures of the message wherever the focus is in the preview.
            content: () => h("div", {
              class: "vh-image-gallery__body",
              onKeydown: (event: KeyboardEvent) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                go(event.key === "ArrowLeft" ? -1 : 1);
              },
            }, [
              h(
                "div",
                { class: "vh-image-dialog__toolbar", "data-closing": closing.value ? "true" : undefined },
                [
                  h("span", { class: "vh-image-dialog__name", title: shown.value?.name }, shown.value?.name),
                  many
                    ? h("span", { class: "vh-image-gallery__count" }, [
                        h(RollNumber, { value: (current.value ?? 0) + 1 }),
                        ` of ${count}`,
                      ])
                    : null,
                  h(UButton, {
                    "aria-label": "Open original image",
                    class: "vh-image-dialog__action",
                    color: "neutral",
                    external: true,
                    icon: icons.value.external,
                    rel: "noreferrer",
                    target: "_blank",
                    to: shown.value?.src,
                    variant: "ghost",
                  }),
                  h(UButton, {
                    "aria-label": "Close image preview",
                    class: "vh-image-dialog__action",
                    color: "neutral",
                    icon: icons.value.close,
                    onClick: () => void close(),
                    variant: "ghost",
                  }),
                ],
              ),
              h(
                "div",
                { class: "vh-image-gallery__stage" },
                [
                  many
                    ? h(UButton, {
                        "aria-label": "Previous picture",
                        class: "vh-image-gallery__step vh-image-gallery__step--previous rounded-full",
                        color: "neutral",
                        icon: icons.value.chevronLeft,
                        onClick: () => go(-1),
                        variant: "solid",
                      })
                    : null,
                  shown.value && failed.value.has(shown.value.key)
                    ? h("p", { class: "vh-image-dialog__error", role: "status" }, "Image unavailable. The file may have been moved or deleted.")
                    : h("img", {
                        alt: shown.value?.name ?? "",
                        class: "vh-image-dialog__image",
                        key: shown.value?.key,
                        onError: () => shown.value && (failed.value = new Set(failed.value).add(shown.value.key)),
                        ref: picture,
                        src: shown.value?.src,
                      }),
                  many
                    ? h(UButton, {
                        "aria-label": "Next picture",
                        class: "vh-image-gallery__step vh-image-gallery__step--next rounded-full",
                        color: "neutral",
                        icon: icons.value.chevronRight,
                        onClick: () => go(1),
                        variant: "solid",
                      })
                    : null,
                ],
              ),
            ]),
          },
        ),
      ]);
    };
  },
});
