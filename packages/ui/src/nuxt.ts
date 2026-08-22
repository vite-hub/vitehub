import {
  addComponent,
  addPlugin,
  createResolver,
  defineNuxtModule,
  installModule,
} from "@nuxt/kit";
import type { ViteHubUIOptions } from "./config.ts";

export interface ViteHubUINuxtModule {
  (inlineOptions?: ViteHubUIOptions, nuxt?: unknown): Promise<void> | void;
  getMeta?: () => Promise<Record<string, unknown>>;
}

const componentNames = [
  "AgentChat",
  "AgentChatMessage",
  "AgentChatPrompt",
  "AgentDiff",
  "AgentFileTree",
  "AgentInvocation",
  "AgentInvocationInspector",
  "AgentInvocationList",
  "AgentMarkdown",
  "AgentMessageParts",
  "AgentSession",
  "AgentTrace",
] as const;

const viteHubUINuxtModule = defineNuxtModule<ViteHubUIOptions>({
  meta: { configKey: "viteHubUI", name: "@vite-hub/ui" },
  defaults: {},
  async setup(options, nuxt) {
    const resolver = createResolver(import.meta.url);
    await installModule("@nuxt/ui", {}, nuxt);
    nuxt.options.css.push("@vite-hub/ui/styles.css");
    nuxt.options.runtimeConfig.public.viteHubUI = options;
    addPlugin(resolver.resolve("./runtime/nuxt-plugin.js"));
    for (const name of componentNames)
      addComponent({ export: name, filePath: "@vite-hub/ui", name });
  },
}) as unknown as ViteHubUINuxtModule;

export default viteHubUINuxtModule;
