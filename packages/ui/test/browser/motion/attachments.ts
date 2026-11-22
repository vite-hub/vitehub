// The comment attachments page: a `CommentComposer` row box in Drop's 340px card, whose pictures sit in a stack, and a
// `CommentReply` of six pictures, whose mosaic opens each one full size. `test/browser/motion-attachments.browser.mjs`
// drives it. The bar on top sets the speed (1×, ¼×) and reduced motion.
import { addCollection } from "@iconify/vue";
import lucide from "@iconify-json/lucide/icons.json";
import "@fontsource-variable/geist";
import type { CommentMessage, CommentThread as Thread } from "@vite-hub/comments/client";
import UButton from "@nuxt/ui/components/Button.vue";
import { createApp, h, ref } from "vue";

import { CommentComposer } from "../../../src/components/comment-composer.ts";
import { CommentReply, CommentThread } from "../../../src/components/comment-thread.ts";
import { createViteHubUI } from "../../../src/config.ts";
import { forceReducedMotion, getMotionSlowFactor, prefersReducedMotion, setMotionSlowFactor } from "../../../src/motion.ts";
import "./attachments.css";

addCollection(lucide);

const slow = ref(getMotionSlowFactor());
const reduced = ref(prefersReducedMotion());
const files = ref<File[]>([]);
const text = ref("");

// A screenshot of a page in one of six colors and shapes, drawn on a canvas.
const palettes = [["#eff6ff", "#2563eb"], ["#f5f5f4", "#ea580c"], ["#f0fdf4", "#16a34a"], ["#faf5ff", "#7c3aed"], ["#fff1f2", "#e11d48"], ["#18181b", "#f59e0b"]];
const shapes = [[640, 400], [640, 420], [360, 640], [640, 360], [560, 420], [480, 480]];
async function picture(index: number): Promise<File> {
  const [width, height] = shapes[index % shapes.length]!;
  const [paper, accent] = palettes[index % palettes.length]!;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = paper;
  context.fillRect(0, 0, width, height);
  context.fillStyle = accent;
  context.fillRect(24, 20, 18, 18);
  context.globalAlpha = 0.25;
  context.fillRect(24, 64, width * 0.6, 14);
  for (let column = 0; column < 3; column++) context.fillRect(24 + column * (width - 48) / 3, 110, (width - 48) / 3 - 12, height - 140);
  context.globalAlpha = 1;
  context.font = "600 28px sans-serif";
  context.fillText(`Screen ${index + 1}`, 54, 40);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((made) => resolve(made!), "image/png"));
  return new File([blob], `Screenshot ${index + 1}.png`, { type: "image/png" });
}

async function start(): Promise<void> {
  const shots = await Promise.all(Array.from({ length: 6 }, (_, index) => picture(index)));
  const urls = new Map(shots.map((file) => [file.name, URL.createObjectURL(file)]));
  const message: CommentMessage = {
    attachments: shots.map((file) => file.name),
    author: { id: "ana", name: "Ana Ruiz" },
    body: "Every breakpoint I checked:",
    createdAt: Date.now() - 40 * 60_000,
    id: "m1",
    mentions: [],
    threadId: "t1",
  };
  const params = new URLSearchParams(location.search);
  const inThread = params.has("thread");
  const threadOpen = ref(true);
  const attachmentUrl = (key: string) => ({ name: key, type: "image/png", url: urls.get(key) ?? "" });
  const thread: Thread = {
    anchor: { kind: "page" }, author: message.author, createdAt: message.createdAt, id: message.threadId,
    messages: [message], n: 1, scope: "site", status: "open", subject: { id: "/", kind: "page" }, updatedAt: message.createdAt,
  };
  const app = createApp({
    setup: () => () =>
      h("div", { class: "page" }, [
        h("div", { class: "controls" }, [
          h(UButton, { "data-test": "speed", variant: "outline", label: slow.value === 1 ? "1×" : "¼×", onClick: () => setMotionSlowFactor(slow.value = slow.value === 1 ? 4 : 1) }),
          h(UButton, { "data-test": "reduce", variant: "outline", "aria-pressed": reduced.value, label: reduced.value ? "Reduced motion on" : "Reduced motion off", onClick: () => forceReducedMotion(reduced.value = !reduced.value) }),
        ]),
        h("div", { class: "card", "data-test": "composer" }, [
          h(CommentComposer, {
            accept: "image/*",
            autofocus: false,
            files: files.value,
            layout: params.has("box") ? "box" : "row",
            modelValue: text.value,
            size: "sm",
            variant: "reply",
            "onUpdate:files": (next: File[]) => (files.value = next),
            "onUpdate:modelValue": (next: string) => (text.value = next),
          }),
        ]),
        h("div", { class: "card", "data-test": "thread" }, [
          inThread
            ? (threadOpen.value ? h(CommentThread, { attachmentUrl, thread, onClose: () => (threadOpen.value = false) }) : null)
            : h(CommentReply, { attachmentUrl, message, size: "sm" }),
        ]),
      ]),
  });
  const { default: ui } = await import("@nuxt/ui/vue-plugin");
  app.component("UButton", UButton);
  app.use(ui).use(createViteHubUI()).mount("#app");
  await document.fonts.ready;
  Object.assign(window, {
    files: () => files.value.map((file) => file.name),
    picture,
    ready: true,
    reduce: (value: boolean) => forceReducedMotion(reduced.value = value),
  });
}

void start();
