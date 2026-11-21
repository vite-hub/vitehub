<script setup lang="ts">
// A docs tutorial layout: the lesson on the left and the live Workspace on the right.
// Query parameters pick a state for screenshots: ?fail=install, ?notice=safari, ?boot=0&tab=connect.
import { defineConnect } from "@vite-hub/web-container/connect";
import {
  BrowserSupportNotice,
  ConnectPanel,
  type ConnectProviderState,
  useConnectStore,
  webContainer,
  Workspace,
  type WorkspaceExample,
} from "@vite-hub/ui/workspace";
import { computed } from "vue";

const query = new URLSearchParams(location.search);
const failInstall = query.get("fail") === "install";
const boot = query.get("boot") !== "0";

const example: WorkspaceExample = {
  id: "hello",
  label: "Hello",
  files: {
    "package.json": JSON.stringify({
      name: "hello",
      private: true,
      type: "module",
      scripts: { dev: "node server.js" },
      dependencies: failInstall ? { "vitehub-package-that-does-not-exist": "1.0.0" } : {},
    }, null, 2),
    "server.js": [
      "import { createServer } from \"node:http\"",
      "import { greeting } from \"./lib/greeting.js\"",
      "",
      "createServer((request, response) => {",
      "  response.setHeader(\"content-type\", \"text/html\")",
      "  response.end(`<h1>${greeting(request.url)}</h1><p>Node ${process.version}</p>`)",
      "}).listen(3000, () => console.log(\"listening on 3000\"))",
    ].join("\n"),
    "lib/greeting.js": "export function greeting(path) {\n  return `Hello from ${path}`\n}\n",
  },
};

const connect = defineConnect({ anthropic: true, cloudflare: { relay: "reader" }, github: true, openai: true, vercel: true });
const runner = webContainer({ connect, port: 3000 });
const store = useConnectStore();

// Without a container, the Connect panel shows each provider state for screenshots.
const states = computed(() => {
  const result: Partial<Record<"openai" | "vercel" | "github", ConnectProviderState>> = {};
  for (const name of ["openai", "vercel", "github"] as const) {
    if (store.credentials.value[name]) result[name] = { account: "reader", status: "connected" };
  }
  if (query.get("tab") === "connect") {
    result.openai = { account: "acme", status: "connected" };
    result.vercel = { status: "error" };
    result.github = { command: "npx vitehub deploy --github", status: "blocked" };
  }
  return result;
});

function copy(text: string) {
  void navigator.clipboard?.writeText(text);
}
// The test reads the WebContainer of the current run.
Object.defineProperty(window, "workspace", { configurable: true, get: () => runner.workspace.value });
</script>

<template>
  <main class="demo">
    <article class="demo-lesson">
      <h1>Serve a page</h1>
      <BrowserSupportNotice
        v-if="query.get('notice')"
        :supported="false"
        :browser="query.get('notice') === 'safari' ? 'safari' : undefined"
      />
      <p>Open <code>lib/greeting.js</code> and change the greeting. The dev server picks up the change when you reload the preview.</p>
    </article>
    <Workspace v-if="boot" :examples="[example]" :runner="runner" name="hello" selected="server.js" :share="false" />
    <ConnectPanel
      v-else
      :connect="connect"
      :states="states"
      relay-url="https://vitehub.dev/docs"
      @connect="(name, token) => store.set(name, token)"
      @disconnect="name => store.remove(name)"
      @remove-all="store.clear()"
      @copy-command="copy"
    />
  </main>
</template>
