/** The SQLite file that OpenWorkflow uses without configured storage, relative to the working directory of the server. */
export const defaultOpenWorkflowSqlitePath = ".vitehub/data/openworkflow.sqlite.db"

/**
 * How many runs one OpenWorkflow worker executes at once without `workflow.worker.concurrency`. OpenWorkflow's own
 * default is 1, and each Agent turn uses two runs: the turn and its recovery run, which waits for the turn to end.
 */
export const defaultOpenWorkflowWorkerConcurrency = 10
