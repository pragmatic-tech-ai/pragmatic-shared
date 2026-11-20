import { PackagePublisher } from './publishing/package-publisher.js';

/**
 * `tsx tools/publish-packages.ts [--dry-run] <package-dir>...` — publishes each built package (in the order given)
 * to GitHub Packages with its `file:` dependencies rewritten to `^<version>`. `--dry-run` packs instead.
 * Authentication comes from the npm userconfig (a token with write:packages).
 */
class PublishCli
{
    private static readonly DryRunFlag = '--dry-run';
    private static readonly Usage = 'usage: tsx tools/publish-packages.ts [--dry-run] <package-dir>...';

    public static Main(args: string[]): number
    {
        const dryRun = args.includes(PublishCli.DryRunFlag);
        const directories = args.filter(arg => arg !== PublishCli.DryRunFlag);
        if (directories.length === 0)
        {
            console.error(PublishCli.Usage);
            return 2;
        }
        const publisher = new PackagePublisher(dryRun, line => console.log(line));
        try
        {
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
}

process.exitCode = PublishCli.Main(process.argv.slice(2));
