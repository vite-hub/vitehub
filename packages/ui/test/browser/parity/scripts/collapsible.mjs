// The fixture: buttons "Before" and "After" around a collapsible. Its trigger is the button "Show details", and its
// content holds the text "Trace details" and the button "Copy trace". It starts closed.
const press = key => page => page.keyboard.press(key);
const clickTrigger = page => page.getByRole("button", { name: "Show details" }).click();

export default [
  { name: "Tab to Before", run: press("Tab") },
  { name: "Tab to the trigger", run: press("Tab") },
  { name: "Enter opens", run: press("Enter") },
  { name: "Tab into the content", run: press("Tab") },
  { name: "Shift+Tab to the trigger", run: press("Shift+Tab") },
  { name: "Space closes", run: press("Space") },
  { name: "Tab skips the closed content", run: press("Tab") },
  { name: "Shift+Tab back to the trigger", run: press("Shift+Tab") },
  { name: "Click opens", run: clickTrigger },
  { name: "Click closes", run: clickTrigger },
];
