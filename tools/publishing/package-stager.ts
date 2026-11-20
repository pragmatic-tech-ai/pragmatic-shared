import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IPackageManifestData, PackageManifest } from './package-manifest.js';

/**
 * Copies the publishable content of a package (the `files` entries plus the files npm always includes) into a
 * fresh directory, with the manifest replaced by the rewritten one.
 */
export class PackageStager
{
    private static readonly StagingPrefix = 'pragmatic-publish-';
    private static readonly AlwaysIncluded = ['README.md', 'LICENSE', 'LICENSE.md', 'CHANGELOG.md'];
    private static readonly ScopeSeparator = '/';
    private static readonly SafeSeparator = '__';

    public Stage(manifest: PackageManifest, published: IPackageManifestData, root: string = os.tmpdir()): string
    {
        const prefix = PackageStager.StagingPrefix + manifest.Name.replace('@', '').replace(PackageStager.ScopeSeparator, PackageStager.SafeSeparator) + '-';
        const entries = PackageStager.Entries(manifest);
        for (const entry of entries)
        {
            if (!fs.existsSync(path.join(manifest.Directory, entry)))
            {
                throw new Error(PackageStager.MissingEntry(manifest.Name, entry));
            }
        }
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

    private static MissingEntry(name: string, entry: string): string
    {
        return `${name}: "${entry}" is listed in files but does not exist (build first)`;
    }

    private static NoFiles(name: string): string
    {
        return `${name}: package.json has no "files" list`;
    }
}
