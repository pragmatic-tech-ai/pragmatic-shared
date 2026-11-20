import { spawnSync } from 'node:child_process';
import { DependencyRewriter, IManifestReader } from './dependency-rewriter.js';
import { PackageManifest } from './package-manifest.js';
import { PackageStager } from './package-stager.js';

/** What happened to one package. */
export enum PublishOutcome
{
    Published = 'published',
    Packed = 'packed',
    AlreadyPublished = 'already published',
}

/**
 * Publishes one built package to GitHub Packages from a staged copy whose `file:` dependencies are version ranges.
 * Lifecycle scripts are not run in the staged copy (the package is built before), and a name@version that
 * already exists is skipped.
 */
export class PackagePublisher implements IManifestReader
{
    public static readonly Registry = 'https://npm.pkg.github.com';
    private static readonly Npm = 'npm';
    private static readonly IgnoreScripts = '--ignore-scripts';
    private static readonly RegistryFlag = '--registry';
    private static readonly Utf8 = 'utf8';
    private static readonly VersionSeparator = '@';
    private static readonly Quote = '"';
    private static readonly Space = ' ';

    private readonly rewriter = new DependencyRewriter(this);
    private readonly stager = new PackageStager();

    public constructor(private readonly dryRun: boolean, private readonly log: (line: string) => void)
    {
    }

    public Read(directory: string): PackageManifest
    {
        return PackageManifest.Read(directory);
    }

    public Publish(directory: string): PublishOutcome
    {
        const manifest = PackageManifest.Read(directory);
        const id = manifest.Name + PackagePublisher.VersionSeparator + manifest.Version;
        if (!this.dryRun && this.Exists(id))
        {
            this.log(`${id}: ${PublishOutcome.AlreadyPublished}, skipped`);
            return PublishOutcome.AlreadyPublished;
        }
        const result = this.rewriter.Rewrite(manifest);
        for (const dependency of result.Rewritten)
        {
            this.log(`${id}: ${dependency.Section}/${dependency.Name} ${dependency.From} -> ${dependency.To}`);
        }
        const staging = this.stager.Stage(manifest, result.Manifest);
        if (this.dryRun)
        {
            this.Run(['pack', PackagePublisher.IgnoreScripts, '--pack-destination', staging], staging);
            this.log(`${id}: ${PublishOutcome.Packed} in ${staging}`);
            return PublishOutcome.Packed;
        }
        try
        {
            this.Run(['publish', PackagePublisher.IgnoreScripts, PackagePublisher.RegistryFlag, PackagePublisher.Registry], staging);
        }
        finally
        {
            PackageStager.Remove(staging);
        }
        this.log(`${id}: ${PublishOutcome.Published}`);
        return PublishOutcome.Published;
    }

    private Exists(id: string): boolean
    {
        const result = spawnSync(PackagePublisher.CommandLine(['view', id, 'version', PackagePublisher.RegistryFlag, PackagePublisher.Registry]), PackagePublisher.SpawnOptions(process.cwd()));
        return result.status === 0 && result.stdout.trim().length > 0;
    }

    private Run(args: string[], cwd: string): void
    {
        const result = spawnSync(PackagePublisher.CommandLine(args), { ...PackagePublisher.SpawnOptions(cwd), stdio: 'inherit' });
        if (result.status !== 0)
        {
            throw new Error(PackagePublisher.CommandFailed(args[0], cwd, result.status));
        }
    }

    private static CommandFailed(command: string, cwd: string, status: number | null): string
    {
        return `npm ${command} failed in ${cwd} (exit ${status})`;
    }

    /**
     * One command line with quoted arguments: npm is a shell script (npm.cmd on Windows), so it runs through the
     * shell. The command itself stays unquoted — a quoted "npm" breaks npm.cmd's own path resolution on Windows.
     */
    public static CommandLine(args: string[]): string
    {
        return [PackagePublisher.Npm, ...args.map(arg => PackagePublisher.Quote + arg + PackagePublisher.Quote)].join(PackagePublisher.Space);
    }

    private static SpawnOptions(cwd: string): { cwd: string; encoding: BufferEncoding; shell: boolean }
    {
        return { cwd, encoding: PackagePublisher.Utf8, shell: true };
    }
}
