/** How often and how long a wait on a cluster object polls (a rollout, a deletion). */
export type OrchestratorPolling = { attempts: number; intervalMs: number }
