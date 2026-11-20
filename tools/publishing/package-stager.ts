import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IPackageManifestData, PackageManifest } from './package-manifest.js';

/**
 * Copies the publishable content of a package (the `files` entries plus the files npm always includes) into a
 * fresh directory, with the manifest replaced by the rewritten one. A build output older than a source file is
 * refused: it would publish code that is not what `src` says.
 */
export class PackageStager
{
    private static readonly StagingPrefix = 'pragmatic-publish-';
    private static readonly AlwaysIncluded = ['README.md', 'LICENSE', 'LICENSE.md', 'CHANGELOG.md'];
    private static readonly ScopeSeparator = '/';
    private static readonly SafeSeparator = '__';
    private static readonly ScopePrefix = '@';
    private static readonly SourceFolder = 'src';
    private static readonly OutputFolder = 'dist';
    private static readonly TestsFolder = 'tests';
    private static readonly TestSuffix = '.test.ts';

    public Stage(manifest: PackageManifest, published: IPackageManifestData, root: string = os.tmpdir()): string
    {
        const prefix = PackageStager.StagingPrefix + manifest.Name.replace(PackageStager.ScopePrefix, '').replace(PackageStager.ScopeSeparator, PackageStager.SafeSeparator) + '-';
        const entries = PackageStager.Entries(manifest);
        for (const entry of entries)
        {
            if (!fs.existsSync(path.join(manifest.Directory, entry)))
            {
                throw new Error(PackageStager.MissingEntry(manifest.Name, entry));
            }
        }
        PackageStager.RequireFreshOutput(manifest);
        const staging = fs.mkdtempSync(path.join(root, prefix));
        for (const entry of entries)
        {
            fs.cpSync(path.join(manifest.Directory, entry), path.join(staging, entry), { recursive: true });
        }
        for (const entry of PackageStager.AlwaysIncluded)
        {
            const source = path.join(manifest.Directory, entry);
            if (fs.existsSync(source)) fs.cpSync(source, path.join(staging, entry));
        }
        fs.writeFileSync(path.join(staging, PackageManifest.FileName), PackageManifest.Serialize(published));
        return staging;
    }

    public static Remove(staging: string): void
    {
        fs.rmSync(staging, { recursive: true, force: true });
    }

    /** The `files` entries of the manifest; a package without them would publish its whole folder, so it is refused. */
    public static Entries(manifest: PackageManifest): string[]
    {
        const files = manifest.Data.files;
        if (files === undefined || files.length === 0)
        {
            throw new Error(PackageStager.NoFiles(manifest.Name));
        }
        return files.filter(entry => !PackageStager.AlwaysIncluded.includes(entry));
    }

    /**
     * Refuses a package whose `dist` is older than its newest source file (tests excluded: the build does not emit
     * them). The build is not incremental, so a fresh build rewrites every output file.
     */
    public static RequireFreshOutput(manifest: PackageManifest): void
    {
        const source = path.join(manifest.Directory, PackageStager.SourceFolder);
        const output = path.join(manifest.Directory, PackageStager.OutputFolder);
        if (!fs.existsSync(source) || !fs.existsSync(output)) return;
        const newestSource = PackageStager.Files(source).filter(file => !PackageStager.IsTest(source, file))
            .reduce<{ File: string; Time: number } | undefined>((newest, file) =>
            {
                const time = fs.statSync(file).mtimeMs;
                return newest === undefined || time > newest.Time ? { File: file, Time: time } : newest;
            }, undefined);
        if (newestSource === undefined) return;
        const stale = PackageStager.Files(output).find(file => fs.statSync(file).mtimeMs < newestSource.Time);
        if (stale !== undefined)
        {
            throw new Error(PackageStager.StaleOutput(manifest.Name, path.relative(manifest.Directory, stale), path.relative(manifest.Directory, newestSource.File)));
        }
    }

    private static Files(directory: string): string[]
    {
        return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
            .filter(entry => entry.isFile())
            .map(entry => path.join(entry.parentPath, entry.name));
    }

    private static IsTest(source: string, file: string): boolean
    {
        return file.endsWith(PackageStager.TestSuffix) || path.relative(source, file).split(path.sep).includes(PackageStager.TestsFolder);
    }

    private static StaleOutput(name: string, output: string, source: string): string
    {
        return `${name}: ${output} is older than ${source} (build first)`;
    }

    private static MissingEntry(name: string, entry: string): string
    {
        return `${name}: "${entry}" is listed in files but does not exist (build first)`;
    }

    private static NoFiles(name: string): string
    {
        return `${name}: package.json has no "files" list`;
    }
}
