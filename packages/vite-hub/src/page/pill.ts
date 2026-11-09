// The page pill as a browser script, `vite-hub/page/pill.js`, for a tool that puts its own bar on a page, such as
// Drop's review toolbar, so it docks, drags, and collapses like ViteHub's page tools. It also has the Related links
// button and menu that such a tool can put in its pill. The file declares one variable, `ViteHubPagePill`, with these
// exports. Paste it inside the tool's own function to keep the page's globals clean.
export { mountViteHubPageLinks, viteHubPageLinksStyles } from "@vite-hub/internal/runtime/page-links"
export { mountViteHubPagePill, readViteHubPageDock, viteHubPagePillStyles, viteHubPageSvgIcon } from "@vite-hub/internal/runtime/page-pill"
export { viteHubPillButtonStyles } from "@vite-hub/internal/runtime/page-tools-shared"
