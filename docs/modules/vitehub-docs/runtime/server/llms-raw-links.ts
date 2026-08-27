import { rewriteLlmsDocsLinks } from "../utils/llms-links";

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook("llms:generate", (_event, options) => {
    rewriteLlmsDocsLinks(options);
  });
});
