import * as fs from 'node:fs';
import * as path from 'node:path';
import { IPackedPackage, PackagePublisher } from './package-publisher.js';
import { IProcessRunner, NpmProcessRunner } from './process-runner.js';
import { IRegistryLookup, NpmRegistryLookup } from './registry-lookup.js';

/**
 * `tsx tools/publish-packages.ts [--dry-run] <package-dir>...` — publishes each built package (in the order given)
 * to GitHub Packages with its `file:` dependencies rewritten to `^<version>`. `--dry-run` packs instead.
 * `--pack-into <dir> <package-dir>...` packs each one as it would be published into `<dir>` and writes the list, in
 * order, to `<dir>/packages.json` (`[{ Name, Version, File }]`): the release workflow publishes those tarballs from
 * a job that runs no repository code.
 * Authentication comes from the npm userconfig (a token with write:packages to publish, read to pack).
 */
export class PublishCli
{
    public static readonly BundleFile = 'packages.json';
    private static readonly DryRunFlag = '--dry-run';
    private static readonly PackIntoFlag = '--pack-into';
    private static readonly FlagPrefix = '--';
    private static readonly JsonIndent = 2;
    private static readonly Newline = '\n';
    private static readonly OkExitCode = 0;
    private static readonly FailExitCode = 1;
    private static readonly UsageExitCode = 2;
    private static readonly Usage = 'usage: tsx tools/publish-packages.ts [--dry-run] <package-dir>... | --pack-into <dir> <package-dir>...';

    public static Main(args: string[], runner: IProcessRunner = new NpmProcessRunner(), registry?: IRegistryLookup): number
    {
        const C = PublishCli;
        const packAt = args.indexOf(C.PackIntoFlag);
        const packInto = packAt < 0 ? undefined : args[packAt + 1];
        const rest = packAt < 0 ? args : args.filter((_arg, index) => index !== packAt && index !== packAt + 1);
        const dryRun = rest.includes(C.DryRunFlag);
        const directories = rest.filter(arg => arg !== C.DryRunFlag);
        const badPackInto = packAt >= 0 && (packInto === undefined || packInto.startsWith(C.FlagPrefix) || dryRun);
        if (directories.length === 0 || badPackInto || directories.some(directory => directory.startsWith(C.FlagPrefix)))
        {
            console.error(C.Usage);
            return C.UsageExitCode;
        }
        const publisher = new PackagePublisher(dryRun, line => console.log(line), runner, registry ?? new NpmRegistryLookup(runner, PackagePublisher.Registry));
        try
        {
            if (packInto !== undefined)
            {
                C.PackAll(publisher, path.resolve(packInto), directories);
                return C.OkExitCode;
            }
            for (const directory of directories)
            {
                publisher.Publish(directory);
            }
        }
        catch (error)
        {
            console.error(error instanceof Error ? error.message : error);
            return C.FailExitCode;
        }
        return C.OkExitCode;
    }

    private static PackAll(publisher: PackagePublisher, destination: string, directories: string[]): void
    {
        fs.mkdirSync(destination, { recursive: true });
        const packed: IPackedPackage[] = directories.map(directory => publisher.Pack(directory, destination));
        fs.writeFileSync(path.join(destination, PublishCli.BundleFile), JSON.stringify(packed, null, PublishCli.JsonIndent) + PublishCli.Newline);
    }
}
