export interface HistoryCheckpoint {
  createdAt: string
  id: string
  name?: string
}

export interface HistoryCheckpointOptions {
  message?: string
}

export interface History<TCheckpoint extends HistoryCheckpoint = HistoryCheckpoint> {
  checkpoint(options?: HistoryCheckpointOptions): Promise<TCheckpoint>
}
