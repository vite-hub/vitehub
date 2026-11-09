import { defineHandler } from "h3"

import { instance } from "../oracle"

export default defineHandler(() => ({ instance }))
