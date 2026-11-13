// The fixture: the button "Show toast", a toast region labelled "Notifications", and the button "After". "Show toast"
// opens one toast with the title "File saved", the action "Undo", and the close button "Dismiss". The toast stays
// open for minutes, and it closes when it is swiped to the right.
const press = key => page => page.keyboard.press(key);

async function show(page) {
  await page.getByRole("button", { name: "Show toast" }).click();
  // Screen readers hear a toast through a live region, which can appear a few frames after the toast.
  await page.waitForFunction(() => [...document.querySelectorAll("[aria-live]")].some(element => element.textContent?.includes("File saved")), undefined, { timeout: 2000 })
    .catch(() => {});
}

async function swipe(page) {
  const box = await page.getByText("File saved", { exact: true }).boundingBox();
  if (!box) throw new Error("The toast is not on screen.");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, y, { steps: 10 });
  await page.mouse.up();
}

export default [
  { name: "Tab to Show toast", run: press("Tab") },
  { name: "Show", run: show },
  { name: "F8 focuses the region", run: press("F8") },
  { name: "Tab to the toast", run: press("Tab") },
  { name: "Tab to Undo", run: press("Tab") },
  { name: "Tab to Dismiss", run: press("Tab") },
  { name: "Enter dismisses", run: press("Enter") },
  { name: "Show again", run: show },
  { name: "Click Dismiss", run: page => page.getByRole("button", { name: "Dismiss" }).click() },
  { name: "Show for Escape", run: show },
  { name: "Escape in the toast closes", run: async (page) => {
    await page.keyboard.press("F8");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
  } },
  { name: "Show for swipe", run: show },
  { name: "Swipe right closes", run: swipe },
];
