import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ComponentDescriptorCli, type ComponentCliOutput, type IReleaseComponentSource } from './component-descriptor-cli.js'

/**
 * The `pragmatic-component-descriptors` command: `--components <module> <command> ...`. The module (a path under the
 * working directory) exports `Components`, the caller's IReleaseComponentSource (a container repository's own
 * descriptor class, or the monorepo's ReleaseComponents); the rest is ComponentDescriptorCli's command line.
 */
export class ComponentDescriptorBin
{
    private static readonly ComponentsFlag = '--components'
    private static readonly ComponentsExport = 'Components'
    private static readonly UsageExitCode = 2
    private static readonly FailExitCode = 1
    private static readonly UsageMessage = 'Usage: pragmatic-component-descriptors --components <module> emit-all --out <dir> | emit --app <app> --digest <sha256:...> --out <file> | vendor --out <dir>'
    private static readonly NoSourcePrefix = 'The module names no Components export: '

    public static async Main(argv: readonly string[], output: ComponentCliOutput): Promise<number>
    {
        const B = ComponentDescriptorBin
        if (argv[0] !== B.ComponentsFlag || argv[1] === undefined)
        {
            output.Err(B.UsageMessage)
            return B.UsageExitCode
        }
        const module = await import(pathToFileURL(resolve(process.cwd(), argv[1])).href) as Record<string, unknown>
        const components = module[B.ComponentsExport] as IReleaseComponentSource | undefined
        if (components === undefined)
        {
            output.Err(B.NoSourcePrefix + argv[1])
            return B.FailExitCode
        }
        return ComponentDescriptorCli.Run(argv.slice(2), output, components)
    }
}
