import * as fs from 'node:fs';
import * as path from 'node:path';
import { DependencyRewriter, IManifestReader, IRewrittenDependency } from './dependency-rewriter.js';
import { DependencySection, PackageManifest } from './package-manifest.js';
import { PackageStager } from './package-stager.js';
import { IProcessRunner, NpmProcessRunner } from './process-runner.js';
import { IRegistryLookup, NpmRegistryLookup } from './registry-lookup.js';

/** A package packed for a later publish: its name, version and tarball file name in the destination folder. */
export interface IPackedPackage
{
    Name: string;
    Version: string;
    File: string;
}

/** What happened to one package. */
export enum PublishOutcome
{
    Published = 'published',
    Packed = 'packed',
    AlreadyPublished = 'already published',
}

/**
 * Publishes one built package to GitHub Packages from a staged copy whose `file:` dependencies are version ranges.
 * Lifecycle scripts are not run in the staged copy (the package is built before), a name@version that already
 * exists is skipped, and a rewritten runtime dependency (dependencies / peer / optional) whose target version is
 * not on the registry is refused: `^<local version>` would publish a range nothing satisfies.
 */
export class PackagePublisher implements IManifestReader
{
    public static readonly Registry = 'https://npm.pkg.github.com';
    private static readonly PackCommand = 'pack';
    private static readonly PublishCommand = 'publish';
    private static readonly PackDestinationFlag = '--pack-destination';
    private static readonly IgnoreScripts = '--ignore-scripts';
    private static readonly RegistryFlag = '--registry';
    private static readonly VersionSeparator = '@';
    private static readonly ScopePrefix = '@';
    private static readonly ScopeSeparator = '/';
    private static readonly TarballSeparator = '-';
    private static readonly TarballExtension = '.tgz';
    private static readonly RegistryCheckedSections: readonly string[] = [DependencySection.Dependencies, DependencySection.PeerDependencies, DependencySection.OptionalDependencies];

    private readonly rewriter = new DependencyRewriter(this);
    private readonly stager = new PackageStager();

    public constructor(
        private readonly dryRun: boolean,
        private readonly log: (line: string) => void,
        private readonly runner: IProcessRunner = new NpmProcessRunner(),
        private readonly registry: IRegistryLookup = new NpmRegistryLookup(runner, PackagePublisher.Registry))
    {
    }

    public Read(directory: string): PackageManifest
    {
        return PackageManifest.Read(directory);
    }

    public Publish(directory: string): PublishOutcome
    {
        const manifest = this.Read(directory);
        const id = PackagePublisher.Id(manifest.Name, manifest.Version);
        if (!this.dryRun && this.registry.Exists(id))
        {
            this.log(`${id}: ${PublishOutcome.AlreadyPublished}, skipped`);
            return PublishOutcome.AlreadyPublished;
        }
        const result = this.rewriter.Rewrite(manifest);
        for (const dependency of result.Rewritten)
        {
            this.log(`${id}: ${dependency.Section}/${dependency.Name} ${dependency.From} -> ${dependency.To}`);
        }
        this.RequirePublishedTargets(id, result.Rewritten);
        const staging = this.stager.Stage(manifest, result.Manifest);
        if (this.dryRun)
        {
            this.Run([PackagePublisher.PackCommand, PackagePublisher.IgnoreScripts, PackagePublisher.PackDestinationFlag, staging], staging);
            this.log(`${id}: ${PublishOutcome.Packed} in ${staging}`);
            return PublishOutcome.Packed;
        }
        try
        {
            this.Run([PackagePublisher.PublishCommand, PackagePublisher.IgnoreScripts, PackagePublisher.RegistryFlag, PackagePublisher.Registry], staging);
        }
        finally
        {
            PackageStager.Remove(staging);
        }
        this.log(`${id}: ${PublishOutcome.Published}`);
        return PublishOutcome.Published;
    }

    /**
     * Packs the package as it would be published (the staged copy with its `file:` dependencies rewritten, scripts
     * ignored) into `destination` and returns its tarball: the release workflow packs in its test job and publishes
     * the tarballs from a job that runs no repository code.
     */
    public Pack(directory: string, destination: string): IPackedPackage
    {
        const manifest = this.Read(directory);
        const id = PackagePublisher.Id(manifest.Name, manifest.Version);
        const result = this.rewriter.Rewrite(manifest);
        this.RequirePublishedTargets(id, result.Rewritten);
        const staging = this.stager.Stage(manifest, result.Manifest);
        try
        {
            this.Run([PackagePublisher.PackCommand, PackagePublisher.IgnoreScripts, PackagePublisher.PackDestinationFlag, destination], staging);
        }
        finally
        {
            PackageStager.Remove(staging);
        }
        const file = PackagePublisher.TarballName(manifest.Name, manifest.Version);
        if (!fs.existsSync(path.join(destination, file)))
        {
            throw new Error(PackagePublisher.TarballMissing(id, file, destination));
        }
        this.log(`${id}: ${PublishOutcome.Packed} as ${file}`);
        return { Name: manifest.Name, Version: manifest.Version, File: file };
    }

    /** The file name `npm pack` gives `name@version`: `@scope/name` becomes `scope-name`. */
    public static TarballName(name: string, version: string): string
    {
        const P = PackagePublisher;
        const flat = name.startsWith(P.ScopePrefix) ? name.slice(P.ScopePrefix.length).replace(P.ScopeSeparator, P.TarballSeparator) : name;
        return flat + P.TarballSeparator + version + P.TarballExtension;
    }

    /** Refuses a rewritten runtime dependency whose target name@version is not on the registry (devDependencies are exempt). */
    private RequirePublishedTargets(id: string, rewritten: IRewrittenDependency[]): void
    {
        const missing = rewritten
            .filter(dependency => PackagePublisher.RegistryCheckedSections.includes(dependency.Section))
            .map(dependency => PackagePublisher.Id(dependency.Name, dependency.Version))
            .filter(target => !this.registry.Exists(target));
        if (missing.length > 0)
        {
            throw new Error(PackagePublisher.UnpublishedTargets(id, missing));
        }
    }

    private Run(args: string[], cwd: string): void
    {
        const result = this.runner.Run(args, cwd, true);
        if (result.Status !== 0)
        {
            throw new Error(PackagePublisher.CommandFailed(args[0], cwd, result.Status));
        }
    }

    private static Id(name: string, version: string): string
    {
        return name + PackagePublisher.VersionSeparator + version;
    }

    private static UnpublishedTargets(id: string, missing: string[]): string
    {
        return `${id}: dependencies not on the registry (publish them first): ${missing.join(', ')}`;
    }

    private static TarballMissing(id: string, file: string, destination: string): string
    {
        return `${id}: npm pack wrote no ${file} into ${destination}`;
    }

    private static CommandFailed(command: string, cwd: string, status: number | null): string
    {
        return `npm ${command} failed in ${cwd} (exit ${status})`;
    }
}
