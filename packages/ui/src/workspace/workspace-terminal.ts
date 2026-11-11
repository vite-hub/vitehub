import { defineComponent, h, onBeforeUnmount, onMounted, type PropType, ref, watch } from "vue";

type Terminal = import("@xterm/xterm").Terminal;

/** Output chunks, optionally carrying the number of characters evicted from the start of a stream. */
export type WorkspaceTerminalOutput = readonly string[] & { readonly offset?: number };

let colorProbe: CanvasRenderingContext2D | null | undefined;

/**
 * A CSS color as `#rrggbbaa`. xterm parses only hex and `rgb()` itself, and it refuses translucent colors in other
 * formats, but the tokens are `oklch()` and `color-mix()`. A canvas reads any CSS color as RGBA bytes. Without a canvas,
 * as on the server or in a test DOM, the color stays as it is.
 */
function toHex(color: string) {
  colorProbe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!colorProbe) return color;
  colorProbe.clearRect(0, 0, 1, 1);
  // A color that the canvas cannot read leaves the fill transparent, so the color stays as it is.
  colorProbe.fillStyle = "transparent";
  colorProbe.fillStyle = color;
  colorProbe.fillRect(0, 0, 1, 1);
  const bytes = colorProbe.getImageData(0, 0, 1, 1).data;
  if (bytes[3] === 0) return color;
  return `#${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function cssColor(element: HTMLElement, name: string) {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  return value ? toHex(value) : undefined;
}

/** The colors of the terminal, from the `--vh-ws-*` tokens of styles.css, which follow the theme and the color mode. */
function terminalTheme(element: HTMLElement) {
  return {
    background: cssColor(element, "--vh-ws-terminal-bg"),
    cursor: cssColor(element, "--vh-ws-terminal-fg"),
    foreground: cssColor(element, "--vh-ws-terminal-fg"),
    selectionBackground: cssColor(element, "--vh-ws-code-selection"),
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
        fontFamily: getComputedStyle(element).getPropertyValue("--vh-ws-font-mono").trim() || "ui-monospace, monospace",
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
