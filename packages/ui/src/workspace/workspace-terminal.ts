import { defineComponent, h, onBeforeUnmount, onMounted, type PropType, ref, watch } from "vue";

type Terminal = import("@xterm/xterm").Terminal;

function cssVariable(element: HTMLElement, name: string, fallback: string) {
  return getComputedStyle(element).getPropertyValue(name).trim() || fallback;
}

/** An xterm.js terminal that shows output chunks, such as `workspace.logs`. xterm loads when the terminal mounts. */
export const WorkspaceTerminal = defineComponent({
  name: "WorkspaceTerminal",
  props: {
    /** Output chunks in order. New chunks at the end are written. A shorter or different array clears the terminal. */
    output: { default: () => [], type: Array as PropType<readonly string[]> },
    label: { default: "Terminal output", type: String },
  },
  emits: {
    /** Keys that the reader types, for the stdin of a process. */
    input: (data: string) => typeof data === "string",
  },
  setup(props, { emit, expose }) {
    const host = ref<HTMLElement | null>(null);
    let terminal: Terminal | undefined;
    let written: readonly string[] = [];
    let observer: ResizeObserver | undefined;
    let disposed = false;

    function write(output: readonly string[]) {
      if (!terminal) return;
      const continues = output.length >= written.length && written.every((chunk, index) => output[index] === chunk);
      if (!continues) {
        terminal.reset();
        written = [];
      }
      for (const chunk of output.slice(written.length)) terminal.write(chunk);
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
        theme: {
          background: cssVariable(element, "--vh-ws-terminal-bg", "#f5f5f5"),
          cursor: cssVariable(element, "--vh-ws-terminal-fg", "#525252"),
          foreground: cssVariable(element, "--vh-ws-terminal-fg", "#525252"),
          selectionBackground: cssVariable(element, "--vh-ws-code-selection", "#009fff2e"),
        },
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
      write(props.output);
    });
    watch(() => props.output, write);
    onBeforeUnmount(() => {
      disposed = true;
      observer?.disconnect();
      terminal?.dispose();
    });
    expose({ clear: () => { terminal?.reset(); written = []; } });

    return () => h("div", { class: "vh-ws-terminal", ref: host });
  },
});
