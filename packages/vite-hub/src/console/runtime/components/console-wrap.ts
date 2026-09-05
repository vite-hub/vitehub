import { ref, watch } from "vue";

const wordWrap = ref(true);
try { wordWrap.value = globalThis.localStorage?.getItem("vitehub.console.wordWrap") !== "false"; } catch {}
watch(wordWrap, value => {
  try { globalThis.localStorage?.setItem("vitehub.console.wordWrap", String(value)); } catch {}
});

/** Shared by file and trace previews, including open inspector panes. */
export function useConsoleWordWrap() { return wordWrap; }
