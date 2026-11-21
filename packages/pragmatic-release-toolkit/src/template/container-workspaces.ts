import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ContainerTemplateError } from './container-template-error.js'

/**
 * The npm workspaces of a container repository, read from its root package.json `workspaces` field (an array, or
 * `{ packages: [...] }`): each entry a folder, or `<dir>/*` for every folder under `<dir>` that holds a package.json.
 * ContainerTemplate renders the install manifests and the runtime copies from these folders.
 */
export class ContainerWorkspaces
{
    private static readonly PackageJson = 'package.json'
    private static readonly WorkspacesField = 'workspaces'
    private static readonly PackagesField = 'packages'
    private static readonly AnyChild = '/*'
    private static readonly Wildcard = '*'
    private static readonly Slash = '/'
    private static readonly Utf8 = 'utf8'
    private static readonly BadFieldPrefix = 'package.json `workspaces` is not a list of folders: '
    private static readonly UnsupportedPatternPrefix = 'Only `<dir>` and `<dir>/*` workspace entries are supported: '

    /** The workspace folders (POSIX, relative to the root), in field order, a `<dir>/*` entry expanded and sorted; none without a package.json. */
    public static Read(repoRoot: string): string[]
    {
        const W = ContainerWorkspaces
        const manifest = join(repoRoot, W.PackageJson)
        if (!existsSync(manifest))
        {
            return []
        }
        const parsed = JSON.parse(readFileSync(manifest, W.Utf8)) as Record<string, unknown>
        return W.Expand(repoRoot, W.EntriesOf(parsed[W.WorkspacesField]))
    }

    private static EntriesOf(field: unknown): string[]
    {
        const W = ContainerWorkspaces
        if (field === undefined)
        {
            return []
        }
        const list = Array.isArray(field) ? field : (typeof field === 'object' && field !== null ? (field as Record<string, unknown>)[W.PackagesField] : undefined)
        if (!Array.isArray(list) || !list.every(entry => typeof entry === 'string'))
        {
            throw new ContainerTemplateError(W.BadFieldPrefix + JSON.stringify(field))
        }
        return list as string[]
    }

    private static Expand(repoRoot: string, entries: readonly string[]): string[]
    {
        const W = ContainerWorkspaces
        const folders: string[] = []
        for (const entry of entries)
        {
            const trimmed = entry.endsWith(W.Slash) ? entry.slice(0, -1) : entry
            if (!trimmed.endsWith(W.AnyChild))
            {
                if (trimmed.includes(W.Wildcard))
                {
                    throw new ContainerTemplateError(W.UnsupportedPatternPrefix + entry)
                }
                folders.push(trimmed)
                continue
            }
            const parent = trimmed.slice(0, -W.AnyChild.length)
            if (parent.includes(W.Wildcard))
            {
                throw new ContainerTemplateError(W.UnsupportedPatternPrefix + entry)
            }
            const dir = join(repoRoot, parent)
            const children = existsSync(dir) ? readdirSync(dir).filter(name => statSync(join(dir, name)).isDirectory() && existsSync(join(dir, name, W.PackageJson))) : []
            folders.push(...children.sort().map(name => parent + W.Slash + name))
        }
        return folders
    }
}
