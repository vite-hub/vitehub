import { defineComponent, h, onBeforeUnmount, onMounted, type PropType, ref, watch } from "vue";

type Terminal = import("@xterm/xterm").Terminal;

/** Output chunks, optionally carrying the number of characters evicted from the start of a stream. */
export type WorkspaceTerminalOutput = readonly string[] & { readonly offset?: number };

function cssVariable(element: HTMLElement, name: string, fallback: string) {
  return getComputedStyle(element).getPropertyValue(name).trim() || fallback;
}

function terminalTheme(element: HTMLElement) {
  return {
    background: cssVariable(element, "--vh-ws-terminal-bg", "#ffffff"),
    cursor: cssVariable(element, "--vh-ws-terminal-fg", "#525252"),
    foreground: cssVariable(element, "--vh-ws-terminal-fg", "#525252"),
    selectionBackground: cssVariable(element, "--vh-ws-code-selection", "#009fff2e"),
  };
}

/** An xterm.js terminal that shows output chunks, such as `workspace.logs`. xterm loads when the terminal mounts. */
export const WorkspaceTerminal = defineComponent({
  name: "WorkspaceTerminal",
  props: {
    /** Output chunks in order. An `offset` preserves incremental writes when old chunks are evicted. Ordinary arrays clear the terminal when replaced. */
    output: { default: () => [], type: Array as PropType<WorkspaceTerminalOutput> },
    label: { default: "Terminal output", type: String },
  },
  emits: {
    /** Keys that the reader types, for the stdin of a process. */
    input: (data: string) => typeof data === "string",
  },
  setup(props, { emit, expose }) {
    const host = ref<HTMLElement | null>(null);
    let terminal: Terminal | undefined;
    let written: WorkspaceTerminalOutput = [];
    let cursor: number | undefined;
    let observer: ResizeObserver | undefined;
    let themeObserver: MutationObserver | undefined;
    let disposed = false;

    function write(output: WorkspaceTerminalOutput) {
      if (!terminal) return;
      if (output.offset !== undefined) {
        const end = output.offset + output.reduce((length, chunk) => length + chunk.length, 0);
        if ((cursor !== undefined && (cursor > end || output.offset < (written.offset ?? 0))) || (cursor === undefined && written.length > 0)) {
          terminal.reset();
          cursor = undefined;
        }
        // Eviction changes the head of the array, but the cursor still identifies unwritten characters.
        let skip = Math.max(0, (cursor ?? output.offset) - output.offset);
        for (const chunk of output) {
          if (skip < chunk.length) terminal.write(chunk.slice(skip));
          skip = Math.max(0, skip - chunk.length);
        }
        cursor = end;
      }
      else {
        const continues = cursor === undefined && output.length >= written.length && written.every((chunk, index) => output[index] === chunk);
        if (!continues) {
          terminal.reset();
          written = [];
        }
        for (const chunk of output.slice(written.length)) terminal.write(chunk);
        cursor = undefined;
      }
      written = output;
    }

    onMounted(async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      const element = host.value;
      if (disposed || !element) return;
      const fit = new FitAddon();
      terminal = new Terminal({
        convertEol: true,
        cursorBlink: false,
        disableStdin: false,
        fontFamily: cssVariable(element, "--vh-ws-font-mono", "\"Geist Mono\", ui-monospace, monospace"),
        fontSize: 12,
        lineHeight: 1.4,
        scrollback: 5000,
        theme: terminalTheme(element),
      });
      terminal.loadAddon(fit);
      terminal.open(element);
      terminal.textarea?.setAttribute("aria-label", props.label);
      terminal.onData(data => emit("input", data));
      // A hidden tab has no size. Fit again when it shows.
      observer = new ResizeObserver(() => {
        if (element.clientWidth > 0 && element.clientHeight > 0) fit.fit();
      });
      observer.observe(element);
      // xterm paints with the colors it gets, so read them again when the color mode class of the page changes.
      themeObserver = new MutationObserver(() => {
        if (terminal) terminal.options.theme = terminalTheme(element);
      });
      themeObserver.observe(document.documentElement, { attributeFilter: ["class", "data-theme"] });
      write(props.output);
    });
    watch(() => props.output, write);
    onBeforeUnmount(() => {
      disposed = true;
      observer?.disconnect();
      themeObserver?.disconnect();
      terminal?.dispose();
    });
    expose({ clear: () => { terminal?.reset(); written = []; cursor = undefined; } });

    return () => h("div", { class: "vh-ws-terminal", ref: host });
  },
});
