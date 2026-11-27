// The fixture: a modal dialog with the trigger "Open settings" and the button "After" next to it. The dialog has the
// title "Settings", the description "Change the session settings.", the text field "Name", and the buttons "Save" and
// "Close". "Close" closes the dialog. An overlay covers the page, and the dialog does not cover the point (10, 10).
const press = key => page => page.keyboard.press(key);
const clickTrigger = page => page.getByRole("button", { name: "Open settings" }).click();

export default [
  { name: "Tab to the trigger", run: press("Tab") },
  { name: "Enter opens", run: press("Enter") },
  { name: "Tab to Save", run: press("Tab") },
  { name: "Tab to Close", run: press("Tab") },
  { name: "Tab wraps to the first field", run: press("Tab") },
  { name: "Shift+Tab wraps to Close", run: press("Shift+Tab") },
  { name: "Escape closes", run: press("Escape") },
  { name: "Click opens", run: clickTrigger },
  { name: "Click outside closes", run: page => page.mouse.click(10, 10) },
  { name: "Space opens", run: press("Space") },
  // When "Space opens" did not open the dialog, there is no Close button, and the next records show it.
  { name: "Click Close", run: async (page) => {
    const close = page.getByRole("button", { name: "Close" });
    if (await close.count()) await close.click();
  } },
  { name: "Tab to After", run: press("Tab") },
];
