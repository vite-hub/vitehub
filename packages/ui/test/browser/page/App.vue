<script setup lang="ts">
// A docs tutorial layout: the lesson on the left and the live workspace on the right.
// Query parameters pick a state for screenshots: ?fail=install, ?notice=safari, ?tab=connect.
import { defineConnect } from "@vite-hub/web-container/connect";
import {
  BrowserSupportNotice,
  ConnectPanel,
  type ConnectProviderState,
  useConnectStore,
  WorkspaceBootStatus,
  WorkspaceEditor,
  WorkspaceFileTree,
  WorkspacePreview,
  WorkspaceShell,
  type WorkspaceTab,
  WorkspaceTerminal,
} from "@vite-hub/ui/workspace";
import { useWebContainer } from "@vite-hub/web-container/vue";
import { computed, ref } from "vue";

const query = new URLSearchParams(location.search);
const failInstall = query.get("fail") === "install";
const immediate = query.get("boot") !== "0";

const files = {
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
};

const connect = defineConnect({ anthropic: true, cloudflare: { relay: "reader" }, github: true, openai: true, vercel: true });
const store = useConnectStore();
const workspace = useWebContainer({ env: store.env(connect), files, immediate });

const tab = ref<WorkspaceTab>((query.get("tab") as WorkspaceTab | null) ?? "preview");
const selected = ref("server.js");
const overlay = ref(true);
const paths = computed(() => Object.keys(workspace.files.value));
const source = computed({
  get: () => workspace.files.value[selected.value] ?? "",
  set: value => void workspace.setFiles({ [selected.value]: value }),
});
const showOverlay = computed(() => overlay.value && workspace.status.value !== "idle" && (workspace.status.value !== "ready" || workspace.failure.value !== undefined));
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

function showOutput() {
  overlay.value = false;
  tab.value = "terminal";
}
function copy(text: string) {
  void navigator.clipboard?.writeText(text);
}
Object.assign(window, { workspace });
</script>

<template>
  <main class="demo">
    <article class="demo-lesson">
      <h1>Serve a page</h1>
      <BrowserSupportNotice
        :reason="query.get('notice') || workspace.support.value?.supported !== false ? undefined : workspace.support.value.reason"
        :supported="query.get('notice') ? false : workspace.support.value?.supported"
        :browser="query.get('notice') === 'safari' ? 'safari' : undefined"
      />
      <p>Open <code>lib/greeting.js</code> and change the greeting. The dev server picks up the change when you reload the preview.</p>
    </article>
    <WorkspaceShell v-model:tab="tab" layout="tutorial">
      <template #toolbar>
        <span class="demo-toolbar-title">hello</span>
        <span class="demo-toolbar-spacer" />
        <button class="vh-ws-button" type="button" @click="workspace.reset()">Reset</button>
        <button class="vh-ws-button" type="button" :disabled="!workspace.container.value" @click="workspace.restart()">Restart server</button>
      </template>
      <template #files>
        <WorkspaceFileTree v-model:selected="selected" :paths="paths" :modified="workspace.modified.value" />
      </template>
      <template #editor>
        <WorkspaceEditor v-model="source" :path="selected" />
      </template>
      <template #preview>
        <WorkspacePreview :url="workspace.previewUrl.value" />
      </template>
      <template #terminal>
        <WorkspaceTerminal :output="workspace.logs.value" />
      </template>
      <template #connect>
        <ConnectPanel
          :connect="connect"
          :states="states"
          relay-url="https://vitehub.dev/docs"
          @connect="(name, token) => store.set(name, token)"
          @disconnect="name => store.remove(name)"
          @remove-all="store.clear()"
          @copy-command="copy"
        />
      </template>
      <template v-if="showOverlay" #overlay>
        <WorkspaceBootStatus
          :status="workspace.status.value"
          :steps="workspace.steps.value"
          :failure="workspace.failure.value"
          :online="workspace.online.value"
          @retry="workspace.boot()"
          @retry-install="workspace.install()"
          @restart="workspace.restart()"
          @show-output="showOutput"
        />
      </template>
    </WorkspaceShell>
  </main>
</template>
