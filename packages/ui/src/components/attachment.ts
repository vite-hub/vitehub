import { defineComponent, h, type PropType, resolveComponent } from "vue";
import { asProp, slotPart } from "../internal/slot-part.ts";

export type AttachmentState = "idle" | "uploading" | "processing" | "error" | "done";
export type AttachmentSize = "default" | "sm" | "xs";
export type AttachmentOrientation = "horizontal" | "vertical";

export const Attachment = defineComponent({
  name: "Attachment",
  props: {
    orientation: { default: "horizontal", type: String as PropType<AttachmentOrientation> },
    size: { default: "default", type: String as PropType<AttachmentSize> },
    state: { default: "done", type: String as PropType<AttachmentState> },
  },
  setup(props, { attrs, slots }) {
    return () =>
      h(
        "div",
        {
          ...attrs,
          "data-orientation": props.orientation,
          "data-size": props.size,
          "data-slot": "attachment",
          "data-state": props.state,
        },
        slots.default?.(),
      );
  },
});

export const AttachmentGroup = slotPart("AttachmentGroup", "attachment-group");

export const AttachmentMedia = defineComponent({
  name: "AttachmentMedia",
  props: {
    variant: { default: "icon", type: String as PropType<"icon" | "image"> },
  },
  setup(props, { attrs, slots }) {
    return () => h("div", { ...attrs, "data-slot": "attachment-media", "data-variant": props.variant }, slots.default?.());
  },
});

export const AttachmentContent = slotPart("AttachmentContent", "attachment-content");
export const AttachmentTitle = slotPart("AttachmentTitle", "attachment-title", "span");
export const AttachmentDescription = slotPart("AttachmentDescription", "attachment-description", "span");
export const AttachmentActions = slotPart("AttachmentActions", "attachment-actions");

// A Nuxt UI button with the compact icon defaults of shadcn/ui's `AttachmentAction`. Other attributes go to `UButton`.
export const AttachmentAction = defineComponent({
  name: "AttachmentAction",
  setup(_props, { attrs, slots }) {
    const UButton = resolveComponent("UButton");
    return () =>
      h(UButton, { ...attrs, color: "neutral", "data-slot": "attachment-action", size: "xs", square: true, variant: "ghost" }, slots);
  },
});

// Covers the whole attachment so a click on any part of it opens the file. Give it an accessible name.
export const AttachmentTrigger = defineComponent({
  name: "AttachmentTrigger",
  props: { as: asProp("button") },
  setup(props, { attrs, slots }) {
    // A `type` attribute from the caller still overrides this default.
    return () =>
      h(
        props.as,
        {
          ...attrs,
          "data-slot": "attachment-trigger",
          type: props.as === "button" ? (attrs.type ?? "button") : attrs.type,
        },
        slots.default?.(),
      );
  },
});
