// PlaygroundContainer on the shell: its toolbar takes the bar slot height and its head rows match the shell.
import { sizes } from "../prototype.mjs"

/** @param {import("../../workspace-parts.browser.mjs").Harness} harness */
export default function ({ test, open, rects, near }) {
  const selectors = {
    toolbar: ".vh-pc-toolbar",
    files: ".vh-pc-files .vh-pc-pane-header",
    head: ".vh-ws-editor-head",
    tabs: ".vh-ws-tab-list",
  }

  for (const layout of ["side", "guide-side"]) {
    test(`PlaygroundContainer ${layout}: the toolbar is ${sizes.bar}px and every head row is ${sizes.head}px`, async () => {
      const page = await open("playground-container", { layout })
      const got = await rects(page, selectors)
      near(got.toolbar.h, sizes.bar, "toolbar height")
      for (const name of ["files", "head", "tabs"]) near(got[name].h, sizes.head, `${name} height`)
      near(got.files.y + got.files.h, got.head.y + got.head.h, "files and editor head bottoms")
      if (layout === "side") near(got.head.y + got.head.h, got.tabs.y + got.tabs.h, "editor head and tab bar bottoms")
    })
  }
}
