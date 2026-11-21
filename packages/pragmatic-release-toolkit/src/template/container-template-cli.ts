import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ClosureCheckConfig } from '../closure/closure-check.js'
import type { ComponentCliOutput } from '../release/component-descriptor-cli.js'
import { ReleaseApps, type ReleaseApp } from '../release/release-tag.js'
import { ContainerRenderArgs } from './container-render-args.js'
import { ContainerTemplate, type ContainerAsset, type ContainerTemplateOptions } from './container-template.js'
import { ContainerWorkspaces } from './container-workspaces.js'

class ContainerTemplateUsageError extends Error
{
}

/**
 * The `pragmatic-container-template` command.
 * - `render --app <app> --entry <path> [--ui <dir>]... [--copy <path>]... [--asset <from>=<to>]... [--dockerignore
 *   <line>]... [--gitignore <line>]... --out <dir>` writes ContainerTemplate's files for one container repository under
 *   `--out` (the repository root; existing files are overwritten) and prints each path. The npm workspaces come from
 *   `<out>/package.json`, which also receives the `pragmaticClosureCheck` field and the render arguments as
 *   `pragmaticContainerTemplate` (both printed instead when there is no package.json yet). `render --out <dir>` alone
 *   renders from that field. The render and every target path are checked before anything is written; an I/O failure
 *   while writing (a full disk, a permission) can still leave the files before it written.
 * - `check [--out <dir>]` renders from the field and names every committed file that differs (exit 1), so CI catches
 *   a hand edit or a template change not yet re-rendered.
 */
export class ContainerTemplateCli
{
    private static readonly CommandRender = 'render'
    private static readonly CommandCheck = 'check'
    private static readonly Here = '.'
    private static readonly CarriageReturns = /\r\n/g
    private static readonly DriftPrefix = 'drift: '
    private static readonly UnparseableManifest = 'drift: package.json (unparseable)'
    private static readonly DriftSummary = 'The rendered files differ from the template: re-render with pragmatic-container-template render --out . and commit'
    private static readonly MatchesMessage = 'The rendered files match the template'
    private static readonly NoArgsMessage = 'No render arguments: give --app and --entry, or keep them in package.json pragmaticContainerTemplate'
    private static readonly FlagPrefix = '--'
    private static readonly FlagApp = 'app'
    private static readonly FlagEntry = 'entry'
    private static readonly FlagOut = 'out'
    private static readonly FlagUi = 'ui'
    private static readonly FlagCopy = 'copy'
    private static readonly FlagAsset = 'asset'
    private static readonly FlagDockerIgnore = 'dockerignore'
    private static readonly FlagGitIgnore = 'gitignore'
    private static readonly SingleFlags: readonly string[] = [ContainerTemplateCli.FlagApp, ContainerTemplateCli.FlagEntry, ContainerTemplateCli.FlagOut]
    private static readonly RepeatedFlags: readonly string[] = [ContainerTemplateCli.FlagUi, ContainerTemplateCli.FlagCopy, ContainerTemplateCli.FlagAsset, ContainerTemplateCli.FlagDockerIgnore, ContainerTemplateCli.FlagGitIgnore]
    private static readonly AssetSeparator = '='
    private static readonly PackageJson = 'package.json'
    private static readonly JsonIndent = 2
    private static readonly Newline = '\n'
    private static readonly Utf8 = 'utf8'
    private static readonly OkExitCode = 0
    private static readonly FailExitCode = 1
    private static readonly UsageExitCode = 2
    private static readonly UsageMessage = 'Usage: pragmatic-container-template render [--app <app> --entry <path> [--ui <dir>]... [--copy <path>]... [--asset <from>=<to>]... [--dockerignore <line>]... [--gitignore <line>]...] --out <dir> | check [--out <dir>]'
    private static readonly UnknownFlagPrefix = 'Unknown option: --'
    private static readonly DuplicateFlagPrefix = 'Option given more than once: --'
    private static readonly MissingFlagPrefix = 'Missing required option: --'
    private static readonly UnknownAppPrefix = 'Not a release app: '
    private static readonly BadAssetPrefix = 'An asset is <from>=<to>: '
    private static readonly NotAFilePrefix = 'Cannot write over a directory: '
    private static readonly NotADirectoryPrefix = 'Cannot write under a file: '
    private static readonly AddFieldPrefix = 'No package.json yet; add to it: '

    public static Run(argv: readonly string[], output: ComponentCliOutput): number
    {
        const C = ContainerTemplateCli
        try
        {
            if (argv[0] === C.CommandCheck)
            {
                return C.Check(argv.slice(1), output)
            }
            if (argv[0] !== C.CommandRender)
            {
                throw new ContainerTemplateUsageError(C.UsageMessage)
            }
            const [single, repeated] = C.ParseFlags(argv.slice(1))
            const out = C.Required(single, C.FlagOut)
            const flagged = single.has(C.FlagApp) || single.has(C.FlagEntry) || repeated.size > 0
            const options = flagged ? C.OptionsOf(single, repeated, out) : ContainerRenderArgs.Read(out)
            if (options === undefined)
            {
                throw new ContainerTemplateUsageError(C.NoArgsMessage)
            }
            const files = C.Expected(out, options)
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
            if (!existsSync(join(out, C.PackageJson)))
            {
                output.Out(C.AddFieldPrefix + JSON.stringify(C.Fields(options)))
            }
            return C.OkExitCode
        }
        catch (error)
        {
            output.Err(error instanceof Error ? error.message : String(error))
            return error instanceof ContainerTemplateUsageError ? C.UsageExitCode : C.FailExitCode
        }
    }

    /**
     * `check [--out <dir>]` (default the working directory): renders from the repository's `pragmaticContainerTemplate`
     * field and compares with the committed files (package.json by its two fields); prints each file that drifted.
     */
    private static Check(args: readonly string[], output: ComponentCliOutput): number
    {
        const C = ContainerTemplateCli
        const [single, repeated] = C.ParseFlags(args)
        if (repeated.size > 0 || single.has(C.FlagApp) || single.has(C.FlagEntry))
        {
            throw new ContainerTemplateUsageError(C.UsageMessage)
        }
        const out = single.get(C.FlagOut) ?? C.Here
        const manifest = join(out, C.PackageJson)
        if (existsSync(manifest))
        {
            C.CommittedManifest(manifest)
        }
        const options = ContainerRenderArgs.Read(out)
        if (options === undefined)
        {
            throw new ContainerTemplateUsageError(C.NoArgsMessage)
        }
        const drift: string[] = []
        for (const [path, text] of C.Expected(out, options))
        {
            const file = join(out, path)
            if (!existsSync(file) || !statSync(file).isFile())
            {
                drift.push(path)
                continue
            }
            if (path === C.PackageJson)
            {
                const expected = JSON.parse(text) as Record<string, unknown>
                const fields = [ContainerRenderArgs.PackageField, ClosureCheckConfig.PackageField]
                if (fields.some(field => JSON.stringify(C.CommittedManifest(file)[field]) !== JSON.stringify(expected[field])))
                {
                    drift.push(path)
                }
                continue
            }
            if (readFileSync(file, C.Utf8).replace(C.CarriageReturns, C.Newline) !== text)
            {
                drift.push(path)
            }
        }
        for (const path of drift)
        {
            output.Err(C.DriftPrefix + path)
        }
        if (drift.length > 0)
        {
            output.Err(C.DriftSummary)
            return C.FailExitCode
        }
        output.Out(C.MatchesMessage)
        return C.OkExitCode
    }

    private static OptionsOf(single: Map<string, string>, repeated: Map<string, string[]>, out: string): ContainerTemplateOptions
    {
        const C = ContainerTemplateCli
        return {
            App: C.AppOf(C.Required(single, C.FlagApp)),
            Entry: C.Required(single, C.FlagEntry),
            UiDirs: repeated.get(C.FlagUi) ?? [],
            ExtraCopies: repeated.get(C.FlagCopy) ?? [],
            Workspaces: ContainerWorkspaces.Read(out),
            Assets: (repeated.get(C.FlagAsset) ?? []).map(asset => C.AssetOf(asset)),
            DockerIgnore: repeated.get(C.FlagDockerIgnore) ?? [],
            GitIgnore: repeated.get(C.FlagGitIgnore) ?? [],
        }
    }

    /**
     * Every rendered file, plus package.json carrying the fields a render sets when the repository has one (a closure
     * check field is removed where the image is not a Node closure).
     */
    private static Expected(out: string, options: ContainerTemplateOptions): Map<string, string>
    {
        const C = ContainerTemplateCli
        const files = new Map(ContainerTemplate.Render(options))
        const manifest = join(out, C.PackageJson)
        if (existsSync(manifest))
        {
            const merged: Record<string, unknown> = { ...C.CommittedManifest(manifest), ...C.Fields(options) }
            if (ContainerTemplate.ClosureCheckOptions(options) === undefined)
            {
                delete merged[ClosureCheckConfig.PackageField]
            }
            files.set(C.PackageJson, JSON.stringify(merged, null, C.JsonIndent) + C.Newline)
        }
        return files
    }

    /** The repository's package.json; one that is not a JSON object is named as such. */
    private static CommittedManifest(file: string): Record<string, unknown>
    {
        const C = ContainerTemplateCli
        let parsed: unknown
        try
        {
            parsed = JSON.parse(readFileSync(file, C.Utf8))
        }
        catch
        {
            throw new Error(C.UnparseableManifest)
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        {
            throw new Error(C.UnparseableManifest)
        }
        return parsed as Record<string, unknown>
    }

    /** The package.json fields a render sets: the closure check options (Node apps) and the render arguments. */
    private static Fields(options: ContainerTemplateOptions): Record<string, unknown>
    {
        const fields: Record<string, unknown> = {}
        const closure = ContainerTemplate.ClosureCheckOptions(options)
        if (closure !== undefined)
        {
            fields[ClosureCheckConfig.PackageField] = closure
        }
        fields[ContainerRenderArgs.PackageField] = ContainerRenderArgs.FieldOf(options)
        return fields
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
