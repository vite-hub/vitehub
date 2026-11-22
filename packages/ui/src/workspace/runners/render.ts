import { computed, h, onScopeDispose, ref, shallowRef } from "vue";
import { type WorkspaceIssue, WorkspaceIssues } from "../workspace-issues.ts";
import type { WorkspaceExample } from "../workspace-examples.ts";
import type { WorkspaceFiles, WorkspaceRun, WorkspaceRunner, WorkspaceRunState } from "../workspace.ts";

/** What `render()` gets back from its function: the HTML of the output, and the problems that it found. */
export interface WorkspaceRenderResult {
  html: string;
  issues?: readonly WorkspaceIssue[];
}

/** What `render()` gives its function with the files. */
export interface WorkspaceRenderContext {
  /** The open example. Read binary files, such as model weights, from `example.assets`. */
  example: WorkspaceExample;
}

export interface RenderRunnerOptions {
  /** Wraps the HTML in the document of the output, with its stylesheets and theme. Defaults to a plain page. */
  document?: (html: string, files: WorkspaceFiles) => string;
}

const debounce = 200;

function plainDocument(html: string) {
  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    + "<style>:root{color-scheme:light}body{margin:0;padding:1.5rem;font:1rem/1.6 system-ui,sans-serif}</style>"
    + `</head><body>${html}</body></html>`;
}

function keepScroll(document: string, top: number) {
  const script = `<script>(()=>{const y=${Math.round(top)};const go=()=>scrollTo(0,y);go();addEventListener("load",go);`
    + `addEventListener("scroll",()=>parent.postMessage({vhWorkspaceScroll:scrollY},"*"),{passive:true})})()</script>`;
  const end = document.lastIndexOf("</body>");
  return end === -1 ? document + script : document.slice(0, end) + script + document.slice(end);
}

function scrollFrom(data: unknown) {
  if (!data || typeof data !== "object" || !("vhWorkspaceScroll" in data)) return undefined;
  return typeof data.vhWorkspaceScroll === "number" ? data.vhWorkspaceScroll : undefined;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Runs the files of a `Workspace` through `fn` in the page, 200 ms after the last edit, and shows the HTML in an
 * Output tab and the problems in an Issues tab. `fn` gets the open example too, with its `assets`. A result for older
 * files never replaces a newer one, and a thrown error becomes an issue. The file of an issue opens in the editor on a
 * click. Every device can run it.
 */
export function render(fn: (files: WorkspaceFiles, context: WorkspaceRenderContext) => Promise<WorkspaceRenderResult>, options: RenderRunnerOptions = {}): WorkspaceRunner {
  const wrap = options.document ?? plainDocument;

  function start({ example: booted, files: initial, show }: Parameters<WorkspaceRunner["start"]>[0]): WorkspaceRun {
    const files = shallowRef<WorkspaceFiles>({ ...initial });
    let example = booted;
    const issues = ref<readonly WorkspaceIssue[]>([]);
    const html = ref<string>();
    const running = ref(true);
    let frame: HTMLIFrameElement | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let runs = 0;
    let scrollTop = 0;
    let stopped = false;

    async function run() {
      clearTimeout(timer);
      const current = ++runs;
      const snapshot = files.value;
      running.value = true;
      try {
        const result = await fn(snapshot, { example });
        if (current !== runs || stopped) return;
        issues.value = result.issues ?? [];
        html.value = keepScroll(wrap(result.html, snapshot), scrollTop);
      }
      catch (error) {
        if (current === runs && !stopped) issues.value = [{ message: message(error) }];
      }
      finally {
        if (current === runs) running.value = false;
      }
    }

    const listen = (event: MessageEvent) => {
      const top = frame && event.source === frame.contentWindow ? scrollFrom(event.data) : undefined;
      if (top !== undefined) scrollTop = top;
    };
    if (typeof window !== "undefined") {
      window.addEventListener("message", listen);
      void run();
    }
    onScopeDispose(() => {
      stopped = true;
      clearTimeout(timer);
      if (typeof window !== "undefined") window.removeEventListener("message", listen);
    });

    const state = computed<WorkspaceRunState>(() => running.value
      ? { label: "Rendering", tone: "busy" }
      : issues.value.length
        ? { label: issues.value.length === 1 ? "1 issue" : `${issues.value.length} issues`, tone: "error" }
        : { label: "Rendered", tone: "ready" });

    return {
      files,
      async setFiles(next, setOptions = {}) {
        files.value = setOptions.mode === "replace" ? { ...next } : { ...files.value, ...next };
        runs++;
        clearTimeout(timer);
        timer = setTimeout(() => void run(), debounce);
      },
      keeps: () => true,
      async open(opened, next) {
        example = opened;
        scrollTop = 0;
        files.value = { ...next };
        await run();
      },
      tabs: computed(() => [
        { label: "Output", value: "output" },
        { badge: issues.value.length || undefined, label: "Issues", value: "issues" },
      ]),
      panel(tab) {
        if (tab === "output") {
          return h("iframe", {
            class: "vh-workspace-frame",
            ref: (element: unknown) => { frame = element instanceof HTMLIFrameElement ? element : undefined; },
            sandbox: "allow-scripts allow-popups",
            srcdoc: html.value,
            title: "Output",
          });
        }
        if (tab === "issues") return h("div", { class: "vh-workspace-scroll" }, h(WorkspaceIssues, { empty: "No issues.", issues: issues.value, onShow: show }));
        return undefined;
      },
      state,
    };
  }

  return { start };
}
