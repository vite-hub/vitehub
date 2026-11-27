// The fixture: buttons "Before" and "After" around a tablist "Surfaces" with the tabs Files, Terminal and Preview.
// Files is selected, and each panel reads "<tab> panel".
const press = key => page => page.keyboard.press(key);

export default [
  { name: "Tab to Before", run: press("Tab") },
  { name: "Tab into the tablist", run: press("Tab") },
  { name: "ArrowRight to Terminal", run: press("ArrowRight") },
  { name: "ArrowRight to Preview", run: press("ArrowRight") },
  { name: "ArrowRight wraps to Files", run: press("ArrowRight") },
  { name: "ArrowLeft wraps to Preview", run: press("ArrowLeft") },
  { name: "Home", run: press("Home") },
  { name: "End", run: press("End") },
  { name: "Tab into the panel", run: press("Tab") },
  { name: "Tab to After", run: press("Tab") },
  { name: "Shift+Tab to the panel", run: press("Shift+Tab") },
  { name: "Shift+Tab to the selected tab", run: press("Shift+Tab") },
  { name: "Click Terminal", run: page => page.getByRole("tab", { name: "Terminal" }).click() },
];
