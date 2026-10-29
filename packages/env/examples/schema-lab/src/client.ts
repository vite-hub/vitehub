import { usePublicEnv } from "#vitehub/env/public";

const output = document.querySelector("#public-config");
if (output) output.textContent = JSON.stringify(usePublicEnv(), null, 2);
