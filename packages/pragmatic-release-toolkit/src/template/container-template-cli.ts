import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ClosureCheckConfig } from '../closure/closure-check.js'
import type { ComponentCliOutput } from '../release/component-descriptor-cli.js'
import { ReleaseApps, type ReleaseApp } from '../release/release-tag.js'
import { ContainerTemplate, type ContainerAsset } from './container-template.js'
import { ContainerWorkspaces } from './container-workspaces.js'

class ContainerTemplateUsageError extends Error
{
}

/**
 * The `pragmatic-container-template` command: `render --app <app> --entry <path> [--ui <dir>]... [--copy <path>]...
 * [--asset <from>=<to>]... [--dockerignore <line>]... --out <dir>` writes ContainerTemplate's files for one container repository under `--out`
 * (the repository root; existing files are overwritten) and prints each path. The npm workspaces come from
 * `<out>/package.json`, which also receives the `pragmaticClosureCheck` field (printed instead when there is no
 * package.json yet). The render and every target path are checked before anything is written; an I/O failure while
 * writing (a full disk, a permission) can still leave the files before it written.
 */
export class ContainerTemplateCli
{
    private static readonly CommandRender = 'render'
    private static readonly FlagPrefix = '--'
    private static readonly FlagApp = 'app'
    private static readonly FlagEntry = 'entry'
    private static readonly FlagOut = 'out'
    private static readonly FlagUi = 'ui'
    private static readonly FlagCopy = 'copy'
    private static readonly FlagAsset = 'asset'
    private static readonly FlagDockerIgnore = 'dockerignore'
    private static readonly SingleFlags: readonly string[] = [ContainerTemplateCli.FlagApp, ContainerTemplateCli.FlagEntry, ContainerTemplateCli.FlagOut]
    private static readonly RepeatedFlags: readonly string[] = [ContainerTemplateCli.FlagUi, ContainerTemplateCli.FlagCopy, ContainerTemplateCli.FlagAsset, ContainerTemplateCli.FlagDockerIgnore]
    private static readonly AssetSeparator = '='
    private static readonly PackageJson = 'package.json'
    private static readonly JsonIndent = 2
    private static readonly Newline = '\n'
    private static readonly Utf8 = 'utf8'
    private static readonly OkExitCode = 0
    private static readonly FailExitCode = 1
    private static readonly UsageExitCode = 2
    private static readonly UsageMessage = 'Usage: pragmatic-container-template render --app <app> --entry <path> [--ui <dir>]... [--copy <path>]... [--asset <from>=<to>]... [--dockerignore <line>]... --out <dir>'
    private static readonly UnknownFlagPrefix = 'Unknown option: --'
    private static readonly DuplicateFlagPrefix = 'Option given more than once: --'
    private static readonly MissingFlagPrefix = 'Missing required option: --'
    private static readonly UnknownAppPrefix = 'Not a release app: '
    private static readonly BadAssetPrefix = 'An asset is <from>=<to>: '
    private static readonly NotAFilePrefix = 'Cannot write over a directory: '
    private static readonly NotADirectoryPrefix = 'Cannot write under a file: '
    private static readonly AddFieldPrefix = 'No package.json yet; add to it: '
    private static readonly FieldSeparator = ': '

    public static Run(argv: readonly string[], output: ComponentCliOutput): number
    {
        const C = ContainerTemplateCli
        try
        {
            if (argv[0] !== C.CommandRender)
            {
                throw new ContainerTemplateUsageError(C.UsageMessage)
            }
            const [single, repeated] = C.ParseFlags(argv.slice(1))
            const out = C.Required(single, C.FlagOut)
            const options = {
                App: C.AppOf(C.Required(single, C.FlagApp)),
                Entry: C.Required(single, C.FlagEntry),
                UiDirs: repeated.get(C.FlagUi) ?? [],
                ExtraCopies: repeated.get(C.FlagCopy) ?? [],
                Workspaces: ContainerWorkspaces.Read(out),
                Assets: (repeated.get(C.FlagAsset) ?? []).map(asset => C.AssetOf(asset)),
                DockerIgnore: repeated.get(C.FlagDockerIgnore) ?? [],
            }
            const files = new Map(ContainerTemplate.Render(options))
            const closure = ContainerTemplate.ClosureCheckOptions(options)
            const manifest = join(out, C.PackageJson)
            if (closure !== undefined && existsSync(manifest))
            {
                const parsed = JSON.parse(readFileSync(manifest, C.Utf8)) as Record<string, unknown>
                parsed[ClosureCheckConfig.PackageField] = closure
                files.set(C.PackageJson, JSON.stringify(parsed, null, C.JsonIndent) + C.Newline)
            }
            for (const path of files.keys())
            {
                C.RequireWritable(out, path)
            }
            for (const [path, text] of files)
            {
                const file = join(out, path)
                mkdirSync(dirname(file), { recursive: true })
                writeFileSync(file, text, C.Utf8)
                output.Out(path)
            }
            if (closure !== undefined && !existsSync(manifest))
            {
                output.Out(C.AddFieldPrefix + JSON.stringify(ClosureCheckConfig.PackageField) + C.FieldSeparator + JSON.stringify(closure))
            }
            return C.OkExitCode
        }
        catch (error)
        {
            output.Err(error instanceof Error ? error.message : String(error))
            return error instanceof ContainerTemplateUsageError ? C.UsageExitCode : C.FailExitCode
        }
    }

    /** The target is not a directory and no folder on its way under `out` is a file. */
    private static RequireWritable(out: string, path: string): void
    {
        const C = ContainerTemplateCli
        const root = resolve(out)
        const file = resolve(root, path)
        if (existsSync(file) && statSync(file).isDirectory())
        {
            throw new Error(C.NotAFilePrefix + file)
        }
        for (let dir = dirname(file); dir.length > root.length && dir.startsWith(root); dir = dirname(dir))
        {
            if (existsSync(dir) && !statSync(dir).isDirectory())
            {
                throw new Error(C.NotADirectoryPrefix + dir)
            }
        }
    }

    private static AssetOf(text: string): ContainerAsset
    {
        const C = ContainerTemplateCli
        const at = text.indexOf(C.AssetSeparator)
        if (at <= 0 || at === text.length - 1)
        {
            throw new ContainerTemplateUsageError(C.BadAssetPrefix + text)
        }
        return { From: text.slice(0, at), To: text.slice(at + 1) }
    }

    private static ParseFlags(args: readonly string[]): [Map<string, string>, Map<string, string[]>]
    {
        const C = ContainerTemplateCli
        const single = new Map<string, string>()
        const repeated = new Map<string, string[]>()
        for (let i = 0; i < args.length; i += 2)
        {
            const arg = args[i]
            const name = arg.startsWith(C.FlagPrefix) ? arg.slice(C.FlagPrefix.length) : undefined
            const value = args[i + 1]
            if (name === undefined || value === undefined)
            {
                throw new ContainerTemplateUsageError(C.UsageMessage)
            }
            if (C.RepeatedFlags.includes(name))
            {
                repeated.set(name, [...(repeated.get(name) ?? []), value])
                continue
            }
            if (!C.SingleFlags.includes(name))
            {
                throw new ContainerTemplateUsageError(C.UnknownFlagPrefix + name)
            }
            if (single.has(name))
            {
                throw new ContainerTemplateUsageError(C.DuplicateFlagPrefix + name)
            }
            single.set(name, value)
        }
        return [single, repeated]
    }

    private static Required(flags: Map<string, string>, name: string): string
    {
        const value = flags.get(name)
        if (value === undefined || value.length === 0)
        {
            throw new ContainerTemplateUsageError(ContainerTemplateCli.MissingFlagPrefix + name)
        }
        return value
    }

    private static AppOf(name: string): ReleaseApp
    {
        const app = ReleaseApps.All.find(candidate => candidate === name)
        if (app === undefined)
        {
            throw new ContainerTemplateUsageError(ContainerTemplateCli.UnknownAppPrefix + name)
        }
        return app
    }
}
