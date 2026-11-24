import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ReleaseApp } from '../release/release-tag.js'
import { ContainerKind, ContainerProfiles, type IContainerHealthcheck, type IContainerProfile } from './container-profile.js'
import { ContainerTemplateError } from './container-template-error.js'

export { ContainerTemplateError } from './container-template-error.js'

/** A runtime asset the compiled modules read relative to themselves: copied from `From` to `To` after the build. */
export type ContainerAsset = { From: string; To: string }

/** What a container repository's files are rendered from (dev-kit A3 plan, Tasks 6-11 table). */
export type ContainerTemplateOptions = {
    App: ReleaseApp
    /**
     * A Node app: its entry source, `[<workspace>/]src/<path>.ts` (compiled to `[<workspace>/]dist/<path>.js`, the
     * ENTRYPOINT). pragmatic-postgres: the repository's own Dockerfile (the image target's context is its folder).
     */
    Entry: string
    /** UI projects (own package.json and lock) built in the image; each one's `dist` is copied into the runtime. */
    UiDirs: readonly string[]
    /** Further repository paths the runtime needs, copied from the pruned build at the same path. */
    ExtraCopies: readonly string[]
    /**
     * The npm workspace folders (ContainerWorkspaces.Read of the root package.json): each one's manifest is installed
     * with the root's, and its package.json, node_modules and dist are copied into the runtime. An entry under a
     * workspace (`server/src/...`) needs its workspace listed.
     */
    Workspaces?: readonly string[]
    /** Runtime assets copied after the build (`src/templates` to `dist/templates`, ...). */
    Assets?: readonly ContainerAsset[]
    /** Lines appended to the common `.dockerignore` after the profile's: one pattern or `#` comment each, no line break. */
    DockerIgnore?: readonly string[]
    /** Lines appended to the common `.gitignore` after the profile's: one pattern or `#` comment each, no line break. */
    GitIgnore?: readonly string[]
    /**
     * The directories the running service writes inside its tree (relative to the repository root, so to
     * `/workspace/<app>`): created when missing and owned by the service user 10001. Everything else the runtime copies
     * stays root's, so the service cannot change its own code.
     */
    WritableDirs?: readonly string[]
}

/** An entry resolved to the paths the files are rendered with. */
type EntryLayout = {
    Workspace: string
    SourceDir: string
    DistDir: string
    EntryScript: string
    ComponentsModule: string
    EntryContext: string
    EntryDockerfile: string
}

/**
 * The files a container repository starts from (templates/container), filled for one release app: the Dockerfile
 * (stages deps, compile, component-set/components, component, build, runtime, the app: packages come from GitHub
 * Packages through the lock, the npmrc is a BuildKit secret, the image carries its component descriptor and its label),
 * docker-bake.hcl (targets `components` and the app), .npmrc, the tsconfigs, .gitattributes, .gitignore, .dockerignore
 * and the caller workflows of pragmatic-shared's reusable container-ci.yml / container-release.yml. pragmatic-postgres
 * keeps its own Dockerfile: it gets components.Dockerfile (the descriptor build) and a bake file over its entry instead.
 * The repository's package.json takes `ClosureCheckOptions` as its `pragmaticClosureCheck` field.
 *
 * The descriptor comes from `<dist>/release-components.js`, which exports `Components` (ContainerComponentSource over
 * the repository's descriptor class), through the `pragmatic-component-descriptors` command.
 */
export class ContainerTemplate
{
    /** The compiled module the descriptor commands load (`--components`), under the app's dist folder. */
    public static readonly ComponentsModuleFile = 'release-components.js'
    /** The closure manifest and Dockerfile a container repository keeps at its root. */
    public static readonly ClosureManifest = 'closure.json'
    public static readonly Dockerfile = 'Dockerfile'
    private static readonly Root = fileURLToPath(new URL('../../templates/container/', import.meta.url))
    private static readonly Utf8 = 'utf8'
    private static readonly ToolkitManifest = fileURLToPath(new URL('../../package.json', import.meta.url))
    private static readonly TagPrefix = 'v'
    /**
     * The ref the caller workflows take pragmatic-shared's reusable workflows at: the tag of this toolkit's version
     * (`v<version>`, protected on pragmatic-shared), so a repository runs the CI of the toolkit its lock installs.
     */
    public static readonly WorkflowRef = ContainerTemplate.TagPrefix
        + (JSON.parse(readFileSync(ContainerTemplate.ToolkitManifest, ContainerTemplate.Utf8)) as { version: string }).version
    private static readonly CommonFiles: ReadonlyArray<readonly [string, string]> = [
        ['.npmrc', 'common/npmrc'],
        ['.gitattributes', 'common/gitattributes'],
        ['.gitignore', 'common/gitignore'],
        ['.dockerignore', 'common/dockerignore'],
        ['tsconfig.json', 'common/tsconfig.json'],
        ['tsconfig.build.json', 'common/tsconfig.build.json'],
        ['.github/workflows/ci.yml', 'common/github/workflows/ci.yml'],
        ['.github/workflows/release.yml', 'common/github/workflows/release.yml'],
    ]
    private static readonly NodeFiles: ReadonlyArray<readonly [string, string]> = [
        [ContainerTemplate.Dockerfile, 'node/Dockerfile'],
        ['docker-bake.hcl', 'node/docker-bake.hcl'],
    ]
    private static readonly ExternalFiles: ReadonlyArray<readonly [string, string]> = [
        ['components.Dockerfile', 'external/components.Dockerfile'],
        ['docker-bake.hcl', 'external/docker-bake.hcl'],
    ]
    private static readonly UiBuildSnippet = 'snippets/ui-build.Dockerfile'
    private static readonly CopySnippet = 'snippets/copy.Dockerfile'
    private static readonly ManifestSnippet = 'snippets/manifest.Dockerfile'
    private static readonly AssetSnippet = 'snippets/asset.Dockerfile'
    private static readonly ClosureCheckSnippet = 'snippets/closure-check.Dockerfile'
    private static readonly PruneSnippet = 'snippets/prune.Dockerfile'
    private static readonly ModuleDirsSnippet = 'snippets/module-dirs.Dockerfile'
    private static readonly AptSnippet = 'snippets/apt.Dockerfile'
    private static readonly EnvSnippet = 'snippets/env.Dockerfile'
    private static readonly ExposeSnippet = 'snippets/expose.Dockerfile'
    private static readonly HealthcheckSnippet = 'snippets/healthcheck.Dockerfile'
    private static readonly ToolsStageSnippet = 'snippets/provisioning-tools-stage.Dockerfile'
    private static readonly ToolsCopySnippet = 'snippets/provisioning-tools-copy.Dockerfile'
    private static readonly HelmArgsSnippet = 'snippets/provisioning-tools-helm-args.Dockerfile'
    private static readonly HelmFetchSnippet = 'snippets/provisioning-tools-helm-fetch.Dockerfile'
    private static readonly HelmCopySnippet = 'snippets/provisioning-tools-helm-copy.Dockerfile'
    private static readonly HelmBinary = ' helm'
    private static readonly WritableDirsSnippet = 'snippets/writable-dirs.Dockerfile'
    private static readonly WorkspaceRoot = '/workspace/'

    private static readonly NodeEntryPattern = /^((?:[^/]+\/)*?)src\/(.+)\.ts$/
    private static readonly DockerfileSuffix = '.Dockerfile'
    private static readonly PathPattern = /^[A-Za-z0-9._@/-]+$/
    private static readonly Placeholder = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g
    private static readonly LinePlaceholder = /^\{\{([A-Za-z][A-Za-z0-9]*)\}\}$/
    private static readonly BlankRuns = /\n{3,}/g
    private static readonly TrailingNewlines = /\n+$/
    private static readonly CarriageReturn = /\r\n/g
    private static readonly Newline = '\n'
    private static readonly BlankLine = '\n\n'
    private static readonly Slash = '/'
    private static readonly Here = '.'
    private static readonly Parent = '..'
    private static readonly Space = ' '
    private static readonly SourceDir = 'src'
    private static readonly DistDir = 'dist'
    private static readonly PackageJson = 'package.json'
    private static readonly NodeModules = 'node_modules'
    private static readonly ScriptExtension = '.js'
    private static readonly True = 'true'
    private static readonly False = 'false'
    private static readonly PortPrefix = 'process.env.'
    private static readonly PortFallback = '||'
    private static readonly InsecureRequestOption = ',rejectUnauthorized:false'

    private static readonly UnknownAppPrefix = 'Not a release app: '
    private static readonly BadPathPrefix = 'Not a relative repository path: '
    private static readonly BadNodeEntryPrefix = 'A Node entry is [<workspace>/]src/<path>.ts: '
    private static readonly BadDockerfileEntryPrefix = 'The entry of a repository that keeps its own Dockerfile names that Dockerfile: '
    private static readonly ExternalExtrasPrefix = 'Keeps its own Dockerfile, so takes no UI dir, extra copy, workspace, asset or writable dir: '
    private static readonly UnlistedWorkspacePrefix = 'The entry lies in a workspace the root package.json does not list: '
    private static readonly MissingValuePrefix = 'Template value missing: '
    private static readonly BadIgnoreLinePrefix = 'An ignore-file line is one pattern or # comment, not empty, no line break: '
    private static readonly LineBreak = /[\r\n]/
    private static readonly Quote = "'"
    private static readonly BadRefusalPrefix = 'A start smoke refusal pattern is one line without a single quote: '
    private static readonly StartSmokeRefusalSnippet = 'snippets/start-smoke-refusal.yml'

    /** Every file of the container repository, path (POSIX, relative to the repository root) to content. */
    public static Render(options: ContainerTemplateOptions): ReadonlyMap<string, string>
    {
        const T = ContainerTemplate
        const profile = T.ProfileOf(options)
        const external = profile.Kind === ContainerKind.ExternalDockerfile
        const layout = external ? T.DockerfileLayout(options.Entry) : T.NodeLayout(options)
        const workspaces = options.Workspaces ?? []
        const values: Record<string, string> = {
            App: options.App,
            WorkflowRef: T.WorkflowRef,
            ...layout,
            UiDirs: options.UiDirs.join(T.Space),
            Node: T.True,
            ClosureCheck: profile.ClosureCheck ? T.True : T.False,
            ImageTest: profile.ImageTest ? T.True : T.False,
            StartSmoke: profile.StartSmoke ? T.True : T.False,
            StartSmokeRefusal: profile.StartSmokeRefusal === undefined ? '' : T.Snippet(T.StartSmokeRefusalSnippet, { Pattern: profile.StartSmokeRefusal }),
            DockerIgnore: [...(profile.DockerIgnore ?? []), ...(options.DockerIgnore ?? [])].join(T.Newline),
            GitIgnore: [...(profile.GitIgnore ?? []), ...(options.GitIgnore ?? [])].join(T.Newline),
            Arm64: profile.MultiArch ? T.True : T.False,
            HelmChart: profile.HelmChart,
            VersionManifest: profile.VersionManifest,
            WorkspaceManifests: workspaces.map(path => T.Snippet(T.ManifestSnippet, { Path: path })).join(T.Newline),
            Assets: (options.Assets ?? []).map(asset => T.Snippet(T.AssetSnippet, { From: asset.From, To: asset.To, ToParent: T.ParentOf(asset.To) })).join(T.Newline),
            UiBuilds: options.UiDirs.map(dir => T.Snippet(T.UiBuildSnippet, { Dir: dir })).join(T.Newline),
            ClosureCheckStep: profile.ClosureCheck ? T.Snippet(T.ClosureCheckSnippet, {}) : '',
            Prune: T.Snippet(T.PruneSnippet, {}),
            ModuleDirs: workspaces.length === 0 ? '' : T.Snippet(T.ModuleDirsSnippet, { Dirs: workspaces.map(path => path + T.Slash + T.NodeModules).join(T.Space) }),
            ToolsStage: profile.ProvisioningTools ? T.ToolsStage(profile) : '',
            RuntimeSetup: T.RuntimeSetup(profile),
            Copies: T.Copies(options, layout).map(path => T.Snippet(T.CopySnippet, { App: options.App, Path: path })).join(T.Newline),
            WritableDirs: T.WritableDirs(options),
            Env: profile.Env.map(([name, value]) => T.Snippet(T.EnvSnippet, { Name: name, Value: value })).join(T.Newline),
            Expose: profile.Ports.length === 0 ? '' : T.Snippet(T.ExposeSnippet, { Ports: profile.Ports.join(T.Space) }),
            Healthcheck: profile.Healthcheck === undefined ? '' : T.Healthcheck(profile.Healthcheck),
        }
        const files = new Map<string, string>()
        for (const [output, template] of [...T.CommonFiles, ...(external ? T.ExternalFiles : T.NodeFiles)])
        {
            files.set(output, T.Fill(T.Read(template), values))
        }
        return files
    }

    /**
     * The repository's package.json `pragmaticClosureCheck` field (ClosureCheckConfig): the root closure.json and
     * Dockerfile, the app, and each workspace's compiled tree; undefined where the image is not a Node closure.
     */
    public static ClosureCheckOptions(options: ContainerTemplateOptions): Record<string, unknown> | undefined
    {
        const T = ContainerTemplate
        const profile = T.ProfileOf(options)
        if (!profile.ClosureCheck)
        {
            return undefined
        }
        const layout = T.NodeLayout(options)
        const config: Record<string, unknown> = { Manifest: T.ClosureManifest, Dockerfile: T.Dockerfile, Apps: [options.App] }
        const workspaces = options.Workspaces ?? []
        if (workspaces.length > 0 || layout.Workspace.length > 0)
        {
            const roots = layout.Workspace.length === 0 ? [[T.DistDir + T.Slash, T.SourceDir + T.Slash]] : []
            roots.push(...workspaces.map(path => [path + T.Slash + T.DistDir + T.Slash, path + T.Slash + T.SourceDir + T.Slash]))
            config.CompiledRoots = roots
        }
        return config
    }

    private static ProfileOf(options: ContainerTemplateOptions): IContainerProfile
    {
        const T = ContainerTemplate
        const profile = ContainerProfiles.Of(options.App)
        if (profile === undefined)
        {
            throw new ContainerTemplateError(T.UnknownAppPrefix + String(options.App))
        }
        const workspaces = options.Workspaces ?? []
        const assets = options.Assets ?? []
        const writable = options.WritableDirs ?? []
        for (const path of [options.Entry, ...options.UiDirs, ...options.ExtraCopies, ...workspaces, ...assets.flatMap(asset => [asset.From, asset.To]), ...writable])
        {
            T.RequirePath(path)
        }
        for (const line of [...(profile.DockerIgnore ?? []), ...(profile.GitIgnore ?? []), ...(options.DockerIgnore ?? []), ...(options.GitIgnore ?? [])])
        {
            if (line.trim().length === 0 || T.LineBreak.test(line))
            {
                throw new ContainerTemplateError(T.BadIgnoreLinePrefix + JSON.stringify(line))
            }
        }
        if (profile.StartSmokeRefusal !== undefined && (T.LineBreak.test(profile.StartSmokeRefusal) || profile.StartSmokeRefusal.includes(T.Quote)))
        {
            throw new ContainerTemplateError(T.BadRefusalPrefix + JSON.stringify(profile.StartSmokeRefusal))
        }
        if (profile.Kind === ContainerKind.ExternalDockerfile && options.UiDirs.length + options.ExtraCopies.length + workspaces.length + assets.length + writable.length > 0)
        {
            throw new ContainerTemplateError(T.ExternalExtrasPrefix + options.App)
        }
        return profile
    }

    private static NodeLayout(options: ContainerTemplateOptions): EntryLayout
    {
        const T = ContainerTemplate
        const match = T.NodeEntryPattern.exec(options.Entry)
        if (match === null)
        {
            throw new ContainerTemplateError(T.BadNodeEntryPrefix + options.Entry)
        }
        const workspace = match[1].length === 0 ? '' : match[1].slice(0, -1)
        if (workspace.length > 0 && !(options.Workspaces ?? []).includes(workspace))
        {
            throw new ContainerTemplateError(T.UnlistedWorkspacePrefix + workspace)
        }
        const dist = match[1] + T.DistDir
        return {
            Workspace: workspace,
            SourceDir: match[1] + T.SourceDir,
            DistDir: dist,
            EntryScript: dist + T.Slash + match[2] + T.ScriptExtension,
            ComponentsModule: dist + T.Slash + T.ComponentsModuleFile,
            EntryContext: T.Here,
            EntryDockerfile: T.Dockerfile,
        }
    }

    private static DockerfileLayout(entry: string): EntryLayout
    {
        const T = ContainerTemplate
        const slash = entry.lastIndexOf(T.Slash)
        const name = entry.slice(slash + 1)
        if (name !== T.Dockerfile && !name.endsWith(T.DockerfileSuffix))
        {
            throw new ContainerTemplateError(T.BadDockerfileEntryPrefix + entry)
        }
        return {
            Workspace: '',
            SourceDir: T.SourceDir,
            DistDir: T.DistDir,
            EntryScript: '',
            ComponentsModule: T.DistDir + T.Slash + T.ComponentsModuleFile,
            EntryContext: slash < 0 ? T.Here : entry.slice(0, slash),
            EntryDockerfile: name,
        }
    }

    /**
     * The runtime's copies from the pruned build: the root package.json and node_modules, the root dist when the entry
     * is not in a workspace, each workspace's package.json, node_modules and dist, the UI dists, then the extra copies
     * (none twice).
     */
    private static Copies(options: ContainerTemplateOptions, layout: EntryLayout): string[]
    {
        const T = ContainerTemplate
        const copies = [T.PackageJson, T.NodeModules]
        if (layout.Workspace.length === 0)
        {
            copies.push(T.DistDir)
        }
        for (const workspace of options.Workspaces ?? [])
        {
            copies.push(workspace + T.Slash + T.PackageJson, workspace + T.Slash + T.NodeModules, workspace + T.Slash + T.DistDir)
        }
        for (const path of [...options.UiDirs.map(dir => dir + T.Slash + T.DistDir), ...options.ExtraCopies])
        {
            if (!copies.includes(path))
            {
                copies.push(path)
            }
        }
        return copies
    }

    /** The image stage's line that hands the writable directories (absolute in the image) to the service user; none: no line. */
    private static WritableDirs(options: ContainerTemplateOptions): string
    {
        const T = ContainerTemplate
        const dirs = (options.WritableDirs ?? []).map(dir => T.WorkspaceRoot + options.App + T.Slash + dir)
        return dirs.length === 0 ? '' : T.Snippet(T.WritableDirsSnippet, { Dirs: dirs.join(T.Space) })
    }

    private static RuntimeSetup(profile: IContainerProfile): string
    {
        const T = ContainerTemplate
        const lines: string[] = []
        if (profile.AptPackages.length > 0)
        {
            lines.push(T.Snippet(T.AptSnippet, { Packages: profile.AptPackages.join(T.Space) }))
        }
        if (profile.ProvisioningTools)
        {
            lines.push(T.Snippet(T.ToolsCopySnippet, {}))
            if (profile.Helm === true)
            {
                lines.push(T.Snippet(T.HelmCopySnippet, {}))
            }
        }
        return lines.join(T.Newline)
    }

    /** The pinned provisioning tools stage; with the profile's Helm, helm 3 is fetched, checked and kept beside the others. */
    private static ToolsStage(profile: IContainerProfile): string
    {
        const T = ContainerTemplate
        const helm = profile.Helm === true
        return T.Snippet(T.ToolsStageSnippet, {
            HelmArgs: helm ? T.Snippet(T.HelmArgsSnippet, {}) : '',
            HelmFetch: helm ? T.Snippet(T.HelmFetchSnippet, {}) : '',
            HelmBinary: helm ? T.HelmBinary : '',
        })
    }

    private static Healthcheck(check: IContainerHealthcheck): string
    {
        const T = ContainerTemplate
        const port = T.PortPrefix + check.PortVariable + (check.DefaultPort === undefined ? '' : T.PortFallback + String(check.DefaultPort))
        return T.Snippet(T.HealthcheckSnippet, {
            Scheme: check.Scheme,
            Port: port,
            RequestOptions: check.Insecure === true ? T.InsecureRequestOption : '',
        })
    }

    private static ParentOf(path: string): string
    {
        const T = ContainerTemplate
        const slash = path.lastIndexOf(T.Slash)
        return slash < 0 ? T.Here : path.slice(0, slash)
    }

    /** A relative POSIX path inside the repository: no absolute path, no `.`/`..` segment, no space or backslash. */
    private static RequirePath(path: string): void
    {
        const T = ContainerTemplate
        const segments = path.split(T.Slash)
        if (!T.PathPattern.test(path) || segments.some(segment => segment.length === 0 || segment === T.Here || segment === T.Parent))
        {
            throw new ContainerTemplateError(T.BadPathPrefix + JSON.stringify(path))
        }
    }

    private static Snippet(template: string, values: Record<string, string>): string
    {
        const T = ContainerTemplate
        return T.Fill(T.Read(template), values).replace(T.TrailingNewlines, '')
    }

    private static Read(template: string): string
    {
        const T = ContainerTemplate
        return readFileSync(join(T.Root, template), T.Utf8).replace(T.CarriageReturn, T.Newline)
    }

    /**
     * Fills `{{Name}}` placeholders. A placeholder alone on its line takes the whole line (a multi-line section) and an
     * empty value drops the line; runs of blank lines collapse to one. A placeholder without a value is an error.
     */
    private static Fill(text: string, values: Record<string, string>): string
    {
        const T = ContainerTemplate
        const lines: string[] = []
        for (const line of text.split(T.Newline))
        {
            const whole = T.LinePlaceholder.exec(line)
            if (whole === null)
            {
                lines.push(line.replace(T.Placeholder, (_match, name: string) => T.Value(values, name)))
                continue
            }
            const value = T.Value(values, whole[1])
            if (value.length > 0)
            {
                lines.push(value)
            }
        }
        return lines.join(T.Newline).replace(T.BlankRuns, T.BlankLine).replace(T.TrailingNewlines, T.Newline)
    }

    private static Value(values: Record<string, string>, name: string): string
    {
        const value = values[name]
        if (value === undefined)
        {
            throw new ContainerTemplateError(ContainerTemplate.MissingValuePrefix + name)
        }
        return value
    }
}
