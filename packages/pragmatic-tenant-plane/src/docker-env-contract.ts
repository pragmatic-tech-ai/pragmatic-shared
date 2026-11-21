import type { EnvDefinition } from './seed/bundle.js'
import type { ILogProcess } from './seed/log-process.js'

/** Docker seam. EnsureImage THROWS when the daemon is unreachable, resolves false when the image is missing. */
export interface IDockerEnv
{
    EnsureImage(): Promise<boolean>
    Up(def: EnvDefinition, bundleDir: string, caHostPath?: string): Promise<void>
    Down(def: EnvDefinition, removeData?: boolean): Promise<void>
    Logs(def: EnvDefinition): Promise<string>
    LogStream(def: EnvDefinition, onData: (chunk: string) => void): ILogProcess
    WaitHealthy(port: number, def: EnvDefinition): Promise<void>
    Running(containerName: string): Promise<boolean>
    RemoveVolume(def: EnvDefinition): Promise<void>
    BuildCommand(): string
}
