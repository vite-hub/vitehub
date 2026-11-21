import type { UIMessage } from "ai";
import { MessageParts as ComarkMessageParts } from "comark-chat/vue";
import { defineComponent, h, type PropType } from "vue";
import { ImagePreview } from "../internal/image-preview.ts";
import { Markdown } from "./markdown.ts";

// comark-chat reads and renders the parts in every framework. ViteHub brings its Markdown, with KaTeX and the typeset
// styles, and its image preview. The caller's slots go last, so they win.
export const MessageParts = defineComponent({
  name: "MessageParts",
  props: {
    parts: { required: true, type: Array as PropType<UIMessage["parts"]> },
    streaming: { default: false, type: Boolean },
  },
  setup(props, { slots }) {
    return () =>
      h(
        ComarkMessageParts,
        { class: "vh-message-parts", "data-slot": "message-parts", parts: props.parts, streaming: props.streaming },
        {
          markdown: ({ value, streaming }: { value: string; streaming: boolean }) => h(Markdown, { streaming, value }),
          file: ({ image, mediaType, name, part }: { image?: string; mediaType: string; name: string; part: { url?: unknown } }) => {
            if (image) return h(ImagePreview, { alt: name, src: image });
            const { url } = part;
            if (typeof url === "string" && url && !URL.canParse(url) && (mediaType === "image" || mediaType.startsWith("image/"))) {
              return h(ImagePreview, { alt: name, src: url });
            }
            return null;
          },
          ...slots,
        },
      );
  },
});
