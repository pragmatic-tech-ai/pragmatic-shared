import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ReleaseApps, type ReleaseApp } from '../release/release-tag.js'
import type { ContainerAsset, ContainerTemplateOptions } from './container-template.js'
import { ContainerTemplateError } from './container-template-error.js'
import { ContainerWorkspaces } from './container-workspaces.js'

/** The render arguments a container repository keeps in its package.json, so a re-render needs no flags. */
export type ContainerRenderArgsField = {
    App: ReleaseApp
    Entry: string
    UiDirs?: string[]
    ExtraCopies?: string[]
    Assets?: ContainerAsset[]
    DockerIgnore?: string[]
    GitIgnore?: string[]
    WritableDirs?: string[]
}

/**
 * The repository's package.json field `pragmaticContainerTemplate`: what `pragmatic-container-template render` was
 * given (app, entry, UI dirs, extra copies, assets, extra ignore lines, the directories the service writes). `render` writes it; `render` without flags and
 * `check` read it, the workspaces coming from the same package.json.
 */
export class ContainerRenderArgs
{
    public static readonly PackageField = 'pragmaticContainerTemplate'
    private static readonly PackageJson = 'package.json'
    private static readonly Utf8 = 'utf8'
    private static readonly ListFields: readonly string[] = ['UiDirs', 'ExtraCopies', 'DockerIgnore', 'GitIgnore', 'WritableDirs']
    private static readonly KnownFields: ReadonlySet<string> = new Set(['App', 'Entry', 'UiDirs', 'ExtraCopies', 'Assets', 'DockerIgnore', 'GitIgnore', 'WritableDirs'])
    private static readonly AssetFields: ReadonlySet<string> = new Set(['From', 'To'])
    private static readonly BadFieldPrefix = 'package.json pragmaticContainerTemplate is not { App, Entry, UiDirs?, ExtraCopies?, Assets?, DockerIgnore?, GitIgnore?, WritableDirs? }: '

    /** The options the repository at `dir` keeps; undefined when its package.json has no such field (or none at all). */
    public static Read(dir: string): ContainerTemplateOptions | undefined
    {
        const R = ContainerRenderArgs
        const manifest = join(dir, R.PackageJson)
        if (!existsSync(manifest))
        {
            return undefined
        }
        const field = (JSON.parse(readFileSync(manifest, R.Utf8)) as Record<string, unknown>)[R.PackageField]
        if (field === undefined)
        {
            return undefined
        }
        const args = R.Validate(field)
        return {
            App: args.App,
            Entry: args.Entry,
            UiDirs: args.UiDirs ?? [],
            ExtraCopies: args.ExtraCopies ?? [],
            Assets: args.Assets ?? [],
            DockerIgnore: args.DockerIgnore ?? [],
            GitIgnore: args.GitIgnore ?? [],
            WritableDirs: args.WritableDirs ?? [],
            Workspaces: ContainerWorkspaces.Read(dir),
        }
    }

    /** The field for `options`: App and Entry, then each list only when it is not empty. */
    public static FieldOf(options: ContainerTemplateOptions): ContainerRenderArgsField
    {
        const field: ContainerRenderArgsField = { App: options.App, Entry: options.Entry }
        if (options.UiDirs.length > 0) field.UiDirs = [...options.UiDirs]
        if (options.ExtraCopies.length > 0) field.ExtraCopies = [...options.ExtraCopies]
        if ((options.Assets ?? []).length > 0) field.Assets = (options.Assets ?? []).map(asset => ({ From: asset.From, To: asset.To }))
        if ((options.DockerIgnore ?? []).length > 0) field.DockerIgnore = [...(options.DockerIgnore ?? [])]
        if ((options.GitIgnore ?? []).length > 0) field.GitIgnore = [...(options.GitIgnore ?? [])]
        if ((options.WritableDirs ?? []).length > 0) field.WritableDirs = [...(options.WritableDirs ?? [])]
        return field
    }

    private static IsText(value: unknown): value is string
    {
        return typeof value === 'string' && value.length > 0
    }

    /** `{ From, To }`, both non-empty, nothing else. */
    private static IsAsset(asset: unknown): asset is ContainerAsset
    {
        const R = ContainerRenderArgs
        if (typeof asset !== 'object' || asset === null || Array.isArray(asset))
        {
            return false
        }
        const value = asset as Record<string, unknown>
        return Object.keys(value).every(key => R.AssetFields.has(key)) && R.IsText(value.From) && R.IsText(value.To)
    }

    private static Validate(field: unknown): ContainerRenderArgsField
    {
        const R = ContainerRenderArgs
        if (typeof field !== 'object' || field === null || Array.isArray(field))
        {
            throw new ContainerTemplateError(R.BadFieldPrefix + JSON.stringify(field))
        }
        const value = field as Record<string, unknown>
        const unknownKey = Object.keys(value).find(key => !R.KnownFields.has(key))
        const app = ReleaseApps.All.find(candidate => candidate === value.App)
        const listsOk = R.ListFields.every(name => value[name] === undefined || (Array.isArray(value[name]) && (value[name] as unknown[]).every(item => typeof item === 'string')))
        const assetsOk = value.Assets === undefined || (Array.isArray(value.Assets) && value.Assets.every(asset => R.IsAsset(asset)))
        if (unknownKey !== undefined || app === undefined || !R.IsText(value.Entry) || !listsOk || !assetsOk)
        {
            throw new ContainerTemplateError(R.BadFieldPrefix + JSON.stringify(field))
        }
        return value as ContainerRenderArgsField
    }
}
