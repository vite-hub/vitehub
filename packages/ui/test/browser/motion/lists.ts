import { addCollection } from "@iconify/vue";
import lucide from "@iconify-json/lucide/icons.json";
import "@fontsource-variable/geist";
import UButton from "@nuxt/ui/components/Button.vue";
import { computed, createApp, h, ref } from "vue";
import type { Component } from "vue";

import { DropField } from "../../../src/components/drop-field.ts";
import { HoldToDelete } from "../../../src/components/hold-to-delete.ts";
import { MotionList } from "../../../src/components/motion-list.ts";
import { Progress } from "../../../src/components/progress.ts";
import { createViteHubUI } from "../../../src/config.ts";
import { forceReducedMotion, getMotionSlowFactor, prefersReducedMotion, setMotionSlowFactor } from "../../../src/motion.ts";
import "./lists.css";

addCollection(lucide);

const query = new URLSearchParams(location.search);
const slow = ref(getMotionSlowFactor());
const reduced = ref(prefersReducedMotion());

let nextRow = 4;
const rows = ref([{ id: 0, name: "brand-guide.pdf" }, { id: 1, name: "cover.png" }, { id: 2, name: "notes.md" }, { id: 3, name: "launch-film.mp4" }]);
const offRows = ref([{ id: 0, name: "One" }, { id: 1, name: "Two" }]);
let duplicateOf: number | undefined;
const rowElements = new Map<number, HTMLElement>();

function addRow(): void {
  rows.value = [rows.value[0]!, { id: nextRow, name: `upload-${nextRow++}.png` }, ...rows.value.slice(1)];
}
function removeRow(): void {
  rows.value = rows.value.filter((_, index) => index !== 1);
}
function shuffleRows(): void {
  rows.value = [...rows.value.slice(1), rows.value[0]!];
}
function duplicateRow(id: number): void {
  const index = rows.value.findIndex(row => row.id === id);
  const source = rows.value[index]!;
  duplicateOf = id;
  rows.value = [...rows.value.slice(0, index + 1), { id: nextRow++, name: `${source.name.replace(/\.(\w+)$/, "")} copy.${source.name.split(".").pop()}` }, ...rows.value.slice(index + 1)];
}

const progressValue = ref<number | null | undefined>(undefined);
const progressDone = ref(false);
let runTimer = 0;
function runUpload(): void {
  cancelAnimationFrame(runTimer);
  progressDone.value = false;
  progressValue.value = 0;
  let elapsed = 0;
  let last = 0;
  const step = (time: number) => {
    elapsed += (last ? time - last : 16) / 1000 / getMotionSlowFactor();
    last = time;
    if (elapsed < 2.4) progressValue.value = elapsed / 2.4;
    else if (elapsed < 4.6) progressValue.value = null;
    else {
      progressDone.value = true;
      return;
    }
    runTimer = requestAnimationFrame(step);
  };
  runTimer = requestAnimationFrame(step);
}

const dropped = ref<string[]>([]);

const cardGone = ref(false);
const commits = ref(0);
const card = ref<HTMLElement>();

interface Entry { id: number; file: File; folder: string; progress: number; state: "queued" | "uploading" | "done" | "failed"; error?: string; result?: undefined }
const entries = ref<Entry[]>([]);
const uploads = {
  entries,
  pending: computed(() => entries.value.filter(entry => entry.state === "queued" || entry.state === "uploading").length),
  add: async () => [],
  clear: () => (entries.value = entries.value.filter(entry => entry.state !== "done" && entry.state !== "failed")),
  dismiss: (id: number) => (entries.value = entries.value.filter(entry => entry.id !== id)),
  retry: async () => undefined,
};
function runUploads(): void {
  const names = ["brand-guide.pdf", "cover.png", "notes.md"];
  entries.value = names.map((name, index) => ({ id: index, file: new File(["x".repeat(2048 * (index + 1))], name), folder: "", progress: 0, state: "queued" }));
  names.forEach((_, index) => {
    let elapsed = -index * 0.6;
    let last = 0;
    const step = (time: number) => {
      elapsed += (last ? time - last : 16) / 1000 / getMotionSlowFactor();
      last = time;
      const patch = (fields: Partial<Entry>) => (entries.value = entries.value.map(entry => (entry.id === index ? { ...entry, ...fields } : entry)));
      if (elapsed < 0) return requestAnimationFrame(step);
      if (elapsed < 2.4) patch({ state: "uploading", progress: elapsed / 2.4 });
      else if (elapsed < 3.6) patch({ state: "uploading", progress: 1 });
      else return patch({ state: "done", progress: 1 });
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function row(title: string, test: string, children: unknown[]) {
  return h("section", { class: "row", "data-test": test }, [h("h2", title), ...children]);
}

async function start(): Promise<void> {
  const mode = query.get("uploads");
  let ConsoleUploads: Component | undefined;
  if (mode === "new") ConsoleUploads = (await import("../../../../vite-hub/src/console/runtime/components/console-media-uploads.vue")).default;
  if (mode === "today") ConsoleUploads = (await import(/* @vite-ignore */ "/@uploads-today")).default;

  const app = createApp({
    render: () => ConsoleUploads
      ? h("main", { class: "page" }, [
          h(UButton, { "data-test": "speed", variant: "outline", label: slow.value === 1 ? "1×" : "¼×", onClick: () => setMotionSlowFactor(slow.value = slow.value === 1 ? 4 : 1) }),
          h(UButton, { "data-test": "run-uploads", label: "Upload 3 files", onClick: runUploads }),
          h("div", { class: "uploads-stage", "data-test": "uploads" }, [h(ConsoleUploads, { uploads })]),
        ])
      : h("main", { class: "page" }, [
          row("Speed and reduced motion", "controls", [
            h(UButton, { "data-test": "speed", variant: "outline", label: slow.value === 1 ? "1×" : "¼×", onClick: () => setMotionSlowFactor(slow.value = slow.value === 1 ? 4 : 1) }),
            h(UButton, { "data-test": "reduce", variant: "outline", "aria-pressed": reduced.value, label: reduced.value ? "Reduced motion on" : "Reduced motion off", onClick: () => forceReducedMotion(reduced.value = !reduced.value) }),
          ]),
          row("MotionList", "list-row", [
            h(UButton, { "data-test": "add", variant: "outline", label: "Add", onClick: addRow }),
            h(UButton, { "data-test": "remove", variant: "outline", label: "Remove second", onClick: removeRow }),
            h(UButton, { "data-test": "shuffle", variant: "outline", label: "Shuffle", onClick: shuffleRows }),
            h(MotionList, { tag: "ul", class: "files", "data-test": "list", origin: () => (duplicateOf === undefined ? undefined : rowElements.get(duplicateOf)) }, () => rows.value.map(item => h("li", {
              key: item.id,
              class: "file",
              "data-id": item.id,
              ref: (element: unknown) => {
                if (element instanceof HTMLElement) rowElements.set(item.id, element);
                else rowElements.delete(item.id);
              },
            }, [
              h("span", item.name),
              h(UButton, { "data-test": `duplicate-${item.id}`, size: "xs", variant: "outline", icon: "i-lucide-copy", label: "Duplicate", onClick: () => duplicateRow(item.id) }),
            ]))),
          ]),
          row("MotionList inside data-motion=none", "off-row", [
            h("div", { "data-motion": "none" }, [
              h(UButton, { "data-test": "off-add", variant: "outline", label: "Add", onClick: () => (offRows.value = [{ id: nextRow++, name: "New" }, ...offRows.value]) }),
              h(MotionList, { tag: "ul", class: "files", "data-test": "off-list" }, () => offRows.value.map(item => h("li", { key: item.id, class: "file" }, item.name))),
            ]),
          ]),
          row("Progress", "progress-row", [
            h("div", { class: "card progress-card" }, [
              h("p", { class: "card-title" }, progressDone.value ? "Uploaded 3 files" : progressValue.value === null ? "Processing 3 files" : progressValue.value === undefined ? "Upload 3 files" : `Uploading 3 files ${Math.round(progressValue.value * 100)}%`),
              h(Progress, { "data-test": "progress", value: progressValue.value, done: progressDone.value, label: "Upload 3 files" }),
            ]),
            h(UButton, { "data-test": "run", variant: "outline", label: "Upload", onClick: runUpload }),
          ]),
          row("DropField", "drop-row", [
            h(DropField, { "data-test": "drop", class: "drop", multiple: true, description: "or click to browse, up to 10 MB", onFiles: (files: File[]) => (dropped.value = files.map(file => file.name)) }),
            h("p", { "data-test": "dropped" }, dropped.value.join(", ")),
          ]),
          row("HoldToDelete", "hold-row", [
            h("div", { class: "hold-stage" }, [
              h("div", { ref: card, class: "card file-card", "data-test": "card", style: cardGone.value ? { visibility: "hidden" } : undefined }, [h("span", "launch-film.mp4"), h("span", { class: "dim" }, "48 MB")]),
              h(HoldToDelete, {
                "data-test": "hold",
                item: () => card.value,
                undoFor: Number(query.get("undoFor") ?? 1500),
                commit: () => void commits.value++,
                onDelete: () => (cardGone.value = true),
                onUndo: () => (cardGone.value = false),
              }),
              h("p", { "data-test": "commits" }, String(commits.value)),
            ]),
          ]),
        ]),
  });
  const { default: ui } = await import("@nuxt/ui/vue-plugin");
  app.component("UButton", UButton);
  app.use(ui).use(createViteHubUI()).mount("#app");
  await document.fonts.ready;
  Object.assign(window, {
    ready: true,
    progress: {
      set: (value: number | null) => {
        progressDone.value = false;
        progressValue.value = value;
      },
      done: () => (progressDone.value = true),
      reset: () => {
        progressDone.value = false;
        progressValue.value = undefined;
      },
    },
    reduce: (value: boolean) => forceReducedMotion(reduced.value = value),
  });
}

void start();
