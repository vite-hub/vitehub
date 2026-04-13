import { H3, serve } from "h3";

import { createDummyMessage } from "@vitehub/dummy";

const app = new H3()
    .get("/", () => createDummyMessage({ label: "h3 example" }));

serve(app);
