// Two pages in one document. A link changes the URL with history.pushState, as a single-page app router does.
const hero = "data:image/svg+xml," + encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='640' height='240'><defs><linearGradient id='g'><stop offset='0' stop-color='#6366f1'/><stop offset='1' stop-color='#ec4899'/></linearGradient></defs><rect width='640' height='240' fill='url(#g)'/><text x='320' y='132' font-size='36' text-anchor='middle' fill='white' font-family='sans-serif'>Hero image</text></svg>",
)

const pages = {
  "/": `
    <h1>Comments demo</h1>
    <p>This page has a heading, a few paragraphs, an image, and a button. Press <kbd>C</kbd>, click anywhere, and leave a note.</p>
    <p>Pins stay on their element when the window resizes. Select some of this text and press <kbd>C</kbd> to comment on the words.</p>
    <img alt="A gradient with the words Hero image" src="${hero}" width="640" height="240" />
    <p>Resolved threads have no pin until the Resolved filter is on. The list button in the toolbar shows every thread of the page.</p>
    <button type="button" id="cta">Buy now</button>
  `,
  "/about": `
    <h1>About</h1>
    <p>You reached this page with a link that calls <code>history.pushState</code>. The overlay follows: its threads are the ones of <code>/about</code> now.</p>
    <p>Go back to the <a href="/" data-link>home page</a> and the first page's pins return.</p>
  `,
}

function render() {
  document.querySelector("#app").innerHTML = pages[location.pathname.replace(/\/+$/, "") || "/"] ?? "<h1>Not found</h1>"
}

document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("a[data-link]") : null
  if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
  event.preventDefault()
  history.pushState(null, "", link.getAttribute("href"))
  render()
})
addEventListener("popstate", render)
render()
