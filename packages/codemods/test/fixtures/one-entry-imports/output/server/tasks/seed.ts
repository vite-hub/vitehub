import { defineTask } from "nitro/task"
import type { TaskEvent, TaskResult } from "nitro/types"

export default defineTask({
  meta: { description: "Add demo rows" },
  async run(event: TaskEvent): Promise<TaskResult> {
    return { result: event.payload }
  },
})
