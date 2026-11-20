import * as fs from 'node:fs';
import * as path from 'node:path';

/** The dependency sections of a package.json that can carry `file:` references. */
export enum DependencySection
{
    Dependencies = 'dependencies',
    DevDependencies = 'devDependencies',
    PeerDependencies = 'peerDependencies',
    OptionalDependencies = 'optionalDependencies',
}

/** The shape of the package.json fields the publish tool reads and rewrites. */
export interface IPackageManifestData
{
    name: string;
    version: string;
    files?: string[];
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    [key: string]: unknown;
}

/** A package.json read from a package directory. */
export class PackageManifest
{
    public static readonly FileName = 'package.json';
    private static readonly Encoding = 'utf8';
    private static readonly Indent = 2;

    public constructor(public readonly Directory: string, public readonly Data: IPackageManifestData)
    {
    }

    public get Name(): string
    {
        return this.Data.name;
    }

    public get Version(): string
    {
        return this.Data.version;
    }

    public static Read(directory: string): PackageManifest
    {
        const file = path.join(directory, PackageManifest.FileName);
        const data = JSON.parse(fs.readFileSync(file, PackageManifest.Encoding)) as IPackageManifestData;
        return new PackageManifest(path.resolve(directory), data);
    }

    public static Serialize(data: IPackageManifestData): string
    {
        return JSON.stringify(data, null, PackageManifest.Indent) + '\n';
    }

    public static Sections(): DependencySection[]
    {
        return Object.values(DependencySection);
    }
}
