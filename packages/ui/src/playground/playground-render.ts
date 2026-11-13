import type { LanguageInput } from "shiki/core";
import { computed, defineComponent, h, onBeforeUnmount, onMounted, type PropType, ref, shallowRef, useId, type VNode } from "vue";
import { useCopy } from "../components/copy-button.ts";
import { icon } from "../workspace/icons.ts";
import {
  decodePlaygroundLink,
  encodePlaygroundLink,
  playgroundLinkLimit,
  playgroundUrl,
  readPlaygroundHash,
  type PlaygroundFiles,
  type PlaygroundTemplate,
} from "./share.ts";
import { downloadZip } from "./zip.ts";

/** An example that the playground can start from. Its `id` goes into share links. */
export interface PlaygroundPreset extends PlaygroundTemplate {
  label: string;
  /** Presets with the same group show under one heading. */
  group?: string;
}

/** An editor tab. It edits one file. */
export interface PlaygroundPane {
  file: string;
  label: string;
  /** The Shiki language that colors the file, such as `"json"`. */
  language?: string;
  /** Shows the slot with this name in place of the text editor, as in Nuxt UI's `UTabs`. */
  slot?: string;
}

export interface PlaygroundIssue {
  message: string;
  line?: number;
}

export interface PlaygroundResult {
  html: string;
  issues?: PlaygroundIssue[];
}

/** The props of the slot of a pane that sets `slot`, such as a theme form that writes `theme.json`. */
export interface PlaygroundPaneSlotProps {
  pane: PlaygroundPane;
  /** The contents of the pane's file, or `""`. */
  value: string;
  files: PlaygroundFiles;
  /** Writes a file. The preview and the link follow 200 ms later. */
  setFile: (path: string, contents: string) => void;
}

/** Renders the files to the HTML of the preview, in the browser. */
export type PlaygroundRenderer = (files: PlaygroundFiles) => Promise<PlaygroundResult>;

const debounce = 200;
const invalidLink = "This link is cut off or changed, so the playground shows an example.";
const tooLong = "This playground is too big for a link. Download it as a zip.";
const noLinks = "This browser cannot write share links. Download the files as a zip.";
const blockedClipboard = "The browser blocked the clipboard. The link is in the address bar.";

function plainPreviewDocument(html: string) {
  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    + "<style>:root{color-scheme:light}body{margin:0;padding:1.5rem;font:1rem/1.6 system-ui,sans-serif}</style>"
    + `</head><body>${html}</body></html>`;
}

/**
 * The preview runs in a sandboxed frame with its own origin, so the page cannot read its scroll position. This script
 * sends the position to the page, and goes back to the last position after each render.
 */
function keepScroll(document: string, top: number) {
  const script = `<script>(()=>{const y=${Math.round(top)};const go=()=>scrollTo(0,y);go();addEventListener("load",go);`
    + `addEventListener("scroll",()=>parent.postMessage({vhPlaygroundScroll:scrollY},"*"),{passive:true})})()</script>`;
  const end = document.lastIndexOf("</body>");
  return end === -1 ? document + script : document.slice(0, end) + script + document.slice(end);
}

function scrollFrom(data: unknown) {
  if (!data || typeof data !== "object" || !("vhPlaygroundScroll" in data)) return undefined;
  return typeof data.vhPlaygroundScroll === "number" ? data.vhPlaygroundScroll : undefined;
}

function sameFiles(a: PlaygroundFiles, b: PlaygroundFiles) {
  const paths = Object.keys(a);
  return paths.length === Object.keys(b).length && paths.every(path => a[path] === b[path]);
}

function groupPresets(presets: readonly PlaygroundPreset[]) {
  const groups = new Map<string | undefined, PlaygroundPreset[]>();
  for (const preset of presets) groups.set(preset.group, [...groups.get(preset.group) ?? [], preset]);
  return [...groups];
}

/**
 * A playground that renders files in the page: editors on one side and the preview on the other. The state is a set
 * of files, kept in the URL hash as a share link of `@vite-hub/ui/playground`.
 */
export const PlaygroundRender = defineComponent({
  name: "PlaygroundRender",
  props: {
    /** The examples. A share link names one of them as its template. */
    presets: { required: true, type: Array as PropType<PlaygroundPreset[]> },
    /** The id of the preset that opens when the URL has no link. Defaults to the first preset. */
    preset: { default: undefined, type: String },
    /** The editor tabs, one file each. */
    panes: { required: true, type: Array as PropType<PlaygroundPane[]> },
    /** Renders the files to HTML. The playground calls it 200 ms after the last edit and drops a result that is out of date. */
    render: { required: true, type: Function as PropType<PlaygroundRenderer> },
    /** Shiki languages that color the panes. They load after the first render. Without them, the panes are plain text. */
    languages: { default: undefined, type: Array as PropType<LanguageInput[]> },
    /** Wraps the rendered HTML in the document of the preview, with its stylesheets and theme. Defaults to a plain page. */
    previewDocument: { default: plainPreviewDocument, type: Function as PropType<(html: string, files: PlaygroundFiles) => string> },
  },
  setup(props, { expose, slots }) {
    const presetById = (id: string | undefined) => props.presets.find(preset => preset.id === id);
    const opening = () => presetById(props.preset) ?? props.presets[0];

    const files = shallowRef<PlaygroundFiles>({ ...opening()?.files });
    const template = ref<string | undefined>(opening()?.id);
    const base = computed(() => presetById(template.value));
    const edited = computed(() => !!base.value && !sameFiles(files.value, base.value.files));
    const active = ref(0);
    const issues = ref<PlaygroundIssue[]>([]);
    const notice = ref<string>();
    const { copy, copied } = useCopy({ duration: 1500 });
    const highlight = shallowRef<(code: string, language: string) => string | undefined>();
    const frame = ref<HTMLIFrameElement | null>(null);
    const confirm = ref<HTMLDialogElement | null>(null);
    const confirmId = useId();

    const stopped = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let runs = 0;
    let loads = 0;
    let writes = 0;
    let scrollTop = 0;
    // A code written for the current files. A hashchange to it needs no load.
    let written: string | undefined;

    function invalidate() {
      clearTimeout(timer);
      runs++;
      writes++;
      loads++;
      written = undefined;
    }

    async function run() {
      const current = ++runs;
      const snapshot = files.value;
      try {
        const result = await props.render(snapshot);
        // A slower render of older files must not replace a newer one.
        if (current !== runs || stopped.signal.aborted) return;
        issues.value = result.issues ?? [];
        if (frame.value) frame.value.srcdoc = keepScroll(props.previewDocument(result.html, snapshot), scrollTop);
      }
      catch (error) {
        if (current === runs && !stopped.signal.aborted) issues.value = [{ message: error instanceof Error ? error.message : String(error) }];
      }
    }

    // Replaced, not pushed: Back leaves the playground instead of stepping through edits.
    async function writeHash() {
      const current = ++writes;
      const code = await encodePlaygroundLink({ template: template.value, files: files.value }, base.value?.files).catch(() => undefined);
      if (current !== writes || stopped.signal.aborted) return false;
      if (code === undefined) {
        notice.value = noLinks;
        return false;
      }
      written = code;
      history.replaceState(history.state, "", playgroundUrl(location.pathname + location.search, code));
      return true;
    }

    function setFile(path: string, contents: string) {
      // Invalidate before the debounce: older work may finish while the reader is still typing.
      invalidate();
      files.value = { ...files.value, [path]: contents };
      notice.value = undefined;
      timer = setTimeout(async () => {
        await Promise.all([writeHash(), run()]);
      }, debounce);
    }

    function open(preset: PlaygroundPreset | undefined, nextFiles: PlaygroundFiles) {
      invalidate();
      template.value = preset?.id;
      files.value = nextFiles;
    }

    async function load() {
      const code = readPlaygroundHash(location.hash);
      if (code && code === written) return;
      invalidate();
      const current = loads;
      const state = code ? await decodePlaygroundLink(code, props.presets) : undefined;
      if (current !== loads || stopped.signal.aborted) return;
      if (state) open(presetById(state.template), state.files);
      else open(opening(), { ...opening()?.files });
      notice.value = code && !state ? invalidLink : undefined;
      await run();
    }

    async function pick(preset: PlaygroundPreset) {
      notice.value = undefined;
      scrollTop = 0;
      open(preset, { ...preset.files });
      await Promise.all([writeHash(), run()]);
    }

    async function copyLink() {
      if (!await writeHash()) return;
      if (location.href.length > playgroundLinkLimit) {
        notice.value = tooLong;
        return;
      }
      if (!await copy(location.href)) notice.value = blockedClipboard;
    }

    onMounted(() => {
      addEventListener("hashchange", load, { signal: stopped.signal });
      addEventListener("message", (event) => {
        const top = event.source === frame.value?.contentWindow ? scrollFrom(event.data) : undefined;
        if (top !== undefined) scrollTop = top;
      }, { signal: stopped.signal });
      const languages = props.languages;
      // The grammar can be as big as the rest of the playground, so it loads after the first render. Until then, and
      // if it fails to load, the panes show plain text.
      void load().then(async () => {
        if (!languages?.length || stopped.signal.aborted) return;
        const color = await import("./highlight.ts").then(module => module.createHighlight(languages)).catch(() => undefined);
        if (!stopped.signal.aborted) highlight.value = color;
      });
    });
    onBeforeUnmount(() => {
      stopped.abort();
      clearTimeout(timer);
    });

    expose({ setFile });

    // Shiki colors the whole file on each call, so each pane keeps its last result.
    const paints = new Map<string, { text: string; color: unknown; html: string | undefined }>();
    function paint(pane: PlaygroundPane, text: string): VNode {
      const color = highlight.value;
      let cached = paints.get(pane.file);
      if (!cached || cached.text !== text || cached.color !== color) {
        cached = { color, html: color && pane.language ? color(text, pane.language) : undefined, text };
        paints.set(pane.file, cached);
      }
      return cached.html === undefined
        ? h("div", { "aria-hidden": "true", class: "vh-pg-paint" }, [h("pre", text)])
        : h("div", { "aria-hidden": "true", class: "vh-pg-paint", innerHTML: cached.html });
    }

    function editor(pane: PlaygroundPane): VNode[] {
      const value = files.value[pane.file] ?? "";
      const custom = pane.slot ? slots[pane.slot] : undefined;
      if (custom) return custom({ files: files.value, pane, setFile, value } satisfies PlaygroundPaneSlotProps);
      return [h("div", { class: "vh-pg-code" }, [
        // The extra line keeps a last empty line as tall in the colored copy as in the textarea.
        paint(pane, `${value}\n `),
        h("textarea", {
          "aria-label": pane.label,
          autocapitalize: "off",
          autocomplete: "off",
          spellcheck: false,
          value,
          onInput: (event: Event) => setFile(pane.file, (event.target as HTMLTextAreaElement).value),
        }),
      ])];
    }

    return () => h("div", { class: "vh-pg" }, [
      props.presets.length > 1
        ? h("nav", { "aria-label": "Examples", class: "vh-pg-presets" }, groupPresets(props.presets).map(([group, presets]) => h("div", { class: "vh-pg-group" }, [
            group ? h("p", { class: "vh-pg-group-title" }, group) : undefined,
            h("ul", presets.map(preset => h("li", { key: preset.id }, [
              h("button", {
                "aria-current": template.value === preset.id && !edited.value ? "true" : undefined,
                "class": "vh-pg-preset",
                "data-focus-inset": "",
                "data-preset": preset.id,
                "type": "button",
                "onClick": () => pick(preset),
              }, slots.preset?.({ active: template.value === preset.id, preset }) ?? preset.label),
            ]))),
          ])))
        : undefined,
      h("div", { class: "vh-pg-editor" }, [
        h("div", { class: "vh-pg-bar" }, [
          props.panes.length > 1
            ? h("div", { "aria-label": "Files", class: "vh-pg-tabs", role: "group" }, props.panes.map((pane, index) => h("button", {
                "aria-pressed": String(active.value === index),
                "class": "vh-pg-tab",
                "data-focus-inset": "",
                "type": "button",
                "onClick": () => { active.value = index; },
              }, pane.label)))
            : h("span", { class: "vh-pg-title" }, props.panes[0]?.label),
          h("div", { class: "vh-pg-actions" }, [
            slots.toolbar?.({ files: files.value, preset: base.value, setFile }),
            edited.value
              ? h("button", { "aria-label": "Reset to the example", "class": "vh-ws-icon-button vh-pg-icon-button", "data-action": "reset", "title": "Reset to the example", "type": "button", "onClick": () => confirm.value?.showModal() }, [icon("rotate-ccw")])
              : undefined,
            h("button", { "aria-label": "Download as a zip", "class": "vh-ws-icon-button vh-pg-icon-button", "data-action": "download", "title": "Download as a zip", "type": "button", "onClick": () => downloadZip(files.value, template.value ?? "playground") }, [icon("download")]),
            h("button", { "class": "vh-ws-button", "data-action": "copy-link", "type": "button", "onClick": copyLink }, [icon(copied.value ? "check" : "link"), copied.value ? "Copied" : "Copy link"]),
          ]),
        ]),
        ...props.panes.map((pane, index) => h("div", { key: pane.file, "class": "vh-pg-pane", "data-file": pane.file, "hidden": active.value !== index }, editor(pane))),
        notice.value ? h("p", { class: "vh-pg-notice", role: "status" }, notice.value) : undefined,
        h("ul", { "aria-label": "Issues", "aria-live": "polite", "class": "vh-pg-issues", "hidden": issues.value.length === 0 }, issues.value.map(issue => h("li", [
          issue.line === undefined ? undefined : h("span", { class: "vh-pg-issue-line" }, `Line ${issue.line}`),
          issue.message,
        ]))),
        // Resetting drops edits that live nowhere else, so it asks first.
        h("dialog", {
          "aria-labelledby": confirmId,
          "class": "vh-pg-confirm",
          "ref": confirm,
          onClose: (event: Event) => {
            const dialog = event.target as HTMLDialogElement;
            if (dialog.returnValue === "reset" && base.value) void pick(base.value);
            dialog.returnValue = "";
          },
        }, [
          h("form", { method: "dialog" }, [
            h("p", { class: "vh-pg-confirm-title", id: confirmId }, "Reset to the example?"),
            h("p", { class: "vh-ws-muted" }, "Your changes will be lost."),
            h("div", { class: "vh-ws-actions" }, [
              h("button", { autofocus: true, class: "vh-ws-button", value: "cancel" }, "Cancel"),
              h("button", { class: "vh-ws-button vh-ws-button--primary", value: "reset" }, "Reset"),
            ]),
          ]),
        ]),
      ]),
      // Scripts run so that the preview works as a real page. The sandbox gives the frame its own origin, so a shared
      // link cannot reach the page.
      h("iframe", { class: "vh-pg-preview", ref: frame, sandbox: "allow-scripts allow-popups", title: "Preview" }),
    ]);
  },
});
