import { docsManifest, getDocsPath } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { frameworks } from "~~/modules/vitehub-docs/runtime/utils/frameworks";

export default defineMcpTool({
  description: "Lists all available documentation pages with title, path, description, and supported frameworks.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {},
  cache: "1h",
  handler: async () => {
    const event = useEvent();
    const origin = getRequestURL(event).origin;

    return docsManifest.sections.flatMap(section =>
      section.pages.flatMap(page =>
        frameworks
          .filter(fw => page.frameworks.includes(fw))
          .map(fw => {
            const path = getDocsPath(section.id, fw, page.id);
            return { title: page.title, path, description: page.description, url: `${origin}${path}` };
          }),
      ),
    );
  },
});
