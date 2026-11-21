/** A hive's rollout state as the tenant plane reads it (the platform console's deployment registry answers it). */
export type EnvironmentRolloutStatus = { environmentName: string; runningImage: string | undefined; obsolete: boolean; ready: boolean }

export type HiveRolloutStatus = { targetVersion: string | undefined; environments: EnvironmentRolloutStatus[] }
