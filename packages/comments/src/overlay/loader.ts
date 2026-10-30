// The page tools loader that pages with the hint load from `/_vitehub/page/assets/loader.js`. Comments serves it, so the page
// tools work without the Console.
import { loadViteHubPageTools } from "@vite-hub/internal/runtime/page-tools-loader"

void loadViteHubPageTools({ session: new URL("../session", import.meta.url).pathname })
