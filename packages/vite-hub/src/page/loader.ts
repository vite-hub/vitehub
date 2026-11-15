// The page tools loader that pages with the hint load from `<base>/_vitehub/page/assets/loader.js`. The Console serves
// it, so the Console link in the pill works in an app without Comments.
import { loadViteHubPageTools } from "@vite-hub/internal/runtime/page-tools-loader"

void loadViteHubPageTools({ session: new URL("../session", import.meta.url).pathname })
