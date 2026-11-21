import * as fs from 'node:fs';
import * as path from 'node:path';
import { IPackedPackage, PackagePublisher } from './publishing/package-publisher.js';

/**
 * `tsx tools/publish-packages.ts [--dry-run] <package-dir>...` — publishes each built package (in the order given)
 * to GitHub Packages with its `file:` dependencies rewritten to `^<version>`. `--dry-run` packs instead.
 * `--pack-into <dir> <package-dir>...` packs each one as it would be published into `<dir>` and writes the list, in
 * order, to `<dir>/packages.json` (`[{ Name, Version, File }]`): the release workflow publishes those tarballs from
 * a job that runs no repository code.
 * Authentication comes from the npm userconfig (a token with write:packages to publish, read to pack).
 */
class PublishCli
{
    private static readonly DryRunFlag = '--dry-run';
    private static readonly PackIntoFlag = '--pack-into';
    private static readonly BundleFile = 'packages.json';
    private static readonly JsonIndent = 2;
    private static readonly Newline = '\n';
    private static readonly Usage = 'usage: tsx tools/publish-packages.ts [--dry-run] <package-dir>... | --pack-into <dir> <package-dir>...';

    public static Main(args: string[]): number
    {
        const packAt = args.indexOf(PublishCli.PackIntoFlag);
        const packInto = packAt < 0 ? undefined : args[packAt + 1];
        const rest = packAt < 0 ? args : args.filter((_arg, index) => index !== packAt && index !== packAt + 1);
        const dryRun = rest.includes(PublishCli.DryRunFlag);
        const directories = rest.filter(arg => arg !== PublishCli.DryRunFlag);
        if (directories.length === 0 || (packAt >= 0 && (packInto === undefined || dryRun)))
        {
            console.error(PublishCli.Usage);
            return 2;
        }
        const publisher = new PackagePublisher(dryRun, line => console.log(line));
        try
        {
            if (packInto !== undefined)
            {
                PublishCli.PackAll(publisher, path.resolve(packInto), directories);
                return 0;
            }
            for (const directory of directories)
            {
                publisher.Publish(directory);
            }
        }
        catch (error)
        {
            console.error(error instanceof Error ? error.message : error);
            return 1;
        }
        return 0;
    }

    private static PackAll(publisher: PackagePublisher, destination: string, directories: string[]): void
    {
        fs.mkdirSync(destination, { recursive: true });
        const packed: IPackedPackage[] = directories.map(directory => publisher.Pack(directory, destination));
        fs.writeFileSync(path.join(destination, PublishCli.BundleFile), JSON.stringify(packed, null, PublishCli.JsonIndent) + PublishCli.Newline);
    }
}

process.exitCode = PublishCli.Main(process.argv.slice(2));
