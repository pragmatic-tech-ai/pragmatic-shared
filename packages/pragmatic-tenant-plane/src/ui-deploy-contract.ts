import type { UiArtifactConfig, UiBundleFile } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import type { EnvironmentRecord } from './environment-record.js'
import type { HiveRecord } from './platform-records.js'

/** The bundle a deploy publishes: the artifact config plus its files. */
export interface UiDeployBundle
{
    config: UiArtifactConfig
    files: readonly UiBundleFile[]
}

/** The deploy seam EnvironmentService delegates to. */
export interface IUiDeployActuator
{
    DeployAppToEnvironment(record: EnvironmentRecord, hive: HiveRecord, bundle: UiDeployBundle): Promise<EnvironmentRecord>
}
