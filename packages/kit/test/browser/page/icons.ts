// Lucide icons that the ui-sdk examples import, drawn here so the fixture needs no icon package.
import { defineComponent, h } from "vue";
import type { Component } from "vue";

type Shape = string | { circle: [number, number, number] } | { rect: [number, number, number, number, number] };

function icon(shapes: Shape[]): Component {
  return defineComponent({
    setup(_, { attrs }) {
      return () =>
        h(
          "svg",
          { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", width: 16, height: 16, ...attrs },
          shapes.map((shape) => {
            if (typeof shape === "string") return h("path", { d: shape });
            if ("circle" in shape) return h("circle", { cx: shape.circle[0], cy: shape.circle[1], r: shape.circle[2] });
            const [x, y, width, height, rx] = shape.rect;
            return h("rect", { x, y, width, height, rx });
          }),
        );
    },
  });
}

export const ArrowRightIcon = icon(["M5 12h14", "m12 5 7 7-7 7"]);
export const BoldIcon = icon(["M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"]);
export const BookmarkIcon = icon(["m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"]);
export const CalculatorIcon = icon([{ rect: [4, 2, 16, 20, 2] }, "M8 6h8", "M16 14v4", "M16 10h.01", "M12 10h.01", "M8 10h.01", "M12 14h.01", "M8 14h.01", "M12 18h.01", "M8 18h.01"]);
export const CalendarIcon = icon(["M8 2v4", "M16 2v4", { rect: [3, 4, 18, 18, 2] }, "M3 10h18"]);
export const CheckIcon = icon(["M20 6 9 17l-5-5"]);
export const ChevronDownIcon = icon(["m6 9 6 6 6-6"]);
export const ChevronLeftIcon = icon(["m15 18-6-6 6-6"]);
export const ChevronRightIcon = icon(["m9 18 6-6-6-6"]);
export const CircleCheckIcon = icon([{ circle: [12, 12, 10] }, "m9 12 2 2 4-4"]);
export const CircleIcon = icon([{ circle: [12, 12, 10] }]);
export const CircleQuestionMarkIcon = icon([{ circle: [12, 12, 10] }, "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3", "M12 17h.01"]);
export const CreditCardIcon = icon([{ rect: [2, 5, 20, 14, 2] }, "M2 10h20"]);
export const EllipsisIcon = icon([{ circle: [12, 12, 1] }, { circle: [19, 12, 1] }, { circle: [5, 12, 1] }]);
export const EyeIcon = icon(["M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0", { circle: [12, 12, 3] }]);
export const EyeOffIcon = icon(["M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49", "M14.084 14.158a3 3 0 0 1-4.242-4.242", "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143", "m2 2 20 20"]);
export const FileIcon = icon(["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4"]);
export const FolderIcon = icon(["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"]);
export const FolderOpenIcon = icon(["m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"]);
export const ItalicIcon = icon(["M19 4h-9", "M14 20H5", "M15 4 9 20"]);
export const LinkIcon = icon(["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"]);
export const MinusIcon = icon(["M5 12h14"]);
export const MoveHorizontalIcon = icon(["m18 8 4 4-4 4", "M2 12h20", "m6 8-4 4 4 4"]);
export const PlusIcon = icon(["M5 12h14", "M12 5v14"]);
export const SearchIcon = icon([{ circle: [11, 11, 8] }, "m21 21-4.3-4.3"]);
export const SettingsIcon = icon([{ circle: [12, 12, 3] }, "M12 2v2", "M12 20v2", "m4.93 4.93 1.41 1.41", "m17.66 17.66 1.41 1.41", "M2 12h2", "M20 12h2", "m6.34 17.66-1.41 1.41", "m19.07 4.93-1.41 1.41"]);
export const SmileIcon = icon([{ circle: [12, 12, 10] }, "M8 14s1.5 2 4 2 4-2 4-2", "M9 9h.01", "M15 9h.01"]);
export const StarIcon = icon(["M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"]);
export const UnderlineIcon = icon(["M6 4v6a6 6 0 0 0 12 0V4", "M4 20h16"]);
export const UploadIcon = icon(["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m17 8-5-5-5 5", "M12 3v12"]);
export const UserIcon = icon(["M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2", { circle: [12, 7, 4] }]);
export const XIcon = icon(["M18 6 6 18", "m6 6 12 12"]);
