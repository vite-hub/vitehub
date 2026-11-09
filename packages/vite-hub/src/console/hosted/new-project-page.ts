/**
 * The page that a static host serves for `/new`, as `new.html`. `index.html` first draws the Console while it opens a
 * project: the sidebar and "Opening Console…". `/new` opens no project and has no sidebar, so on that page the sidebar
 * would show and then disappear. This page keeps only the message for a browser without JavaScript.
 */
export function consoleNewProjectPage(index: string): string {
  const app = /<div id="app">.*<\/div>$/m;
  const noscript = /<noscript[^>]*>.*?<\/noscript>/.exec(index)?.[0];
  if (!app.test(index) || !noscript) throw new Error("index.html of the hosted Console has no one-line #app with a <noscript> message.");
  return index.replace(app, `<div id="app">${noscript}</div>`);
}
