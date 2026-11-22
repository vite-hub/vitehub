// A WebContainer that boots at once and serves a blank preview, so Workspace with webContainer() renders its bar, tabs and
// dialogs without StackBlitz. `ui-sdk.browser.mjs` resolves `@vite-hub/web-container` to this file.
export function checkWebContainerSupport() {
  return { supported: true as const };
}

export async function bootWebContainer(options: { files?: Record<string, string>, onStatus?: (status: unknown) => void } = {}) {
  const disk = new Map(Object.entries(options.files ?? {}));
  options.onStatus?.({ stage: "mounting", steps: [] });
  let ready: (server: { port: number, url: string }) => void = () => {};
  const serverReady = new Promise<{ port: number, url: string }>((resolve) => { ready = resolve; });
  let url: string | undefined;
  return {
    status: { stage: "mounting", steps: [] },
    preview: { ready: serverReady, get url() { return url; } },
    fs: {
      mkdir: async () => {},
      readFile: async (path: string) => disk.get(path) ?? "",
      readdir: async () => [],
      rm: async (path: string) => { disk.delete(path); },
      writeFile: async (path: string, contents: string) => { disk.set(path, contents); },
    },
    on: () => () => {},
    async run(command: unknown) {
      if (command !== "install") {
        url = "about:blank";
        ready({ port: 3000, url });
      }
      return { exit: new Promise<number>(() => {}), kill: () => {}, output: new ReadableStream<string>() };
    },
    teardown: () => {},
  };
}
