import * as path from 'node:path';
import { IPackageManifestData, PackageManifest } from './package-manifest.js';

/** Reads the manifest of a `file:` dependency's target directory. */
export interface IManifestReader
{
    Read(directory: string): PackageManifest;
}

/** One `file:` dependency turned into a version range. */
export interface IRewrittenDependency
{
    Section: string;
    Name: string;
    From: string;
    To: string;
    /** The version of the package the `file:` reference pointed at. */
    Version: string;
}

/** The manifest to publish plus what was rewritten in it. */
export interface IRewriteResult
{
    Manifest: IPackageManifestData;
    Rewritten: IRewrittenDependency[];
}

/**
 * Turns every `file:` dependency of a package into `^<version>` of the package it points at, so a published
 * manifest never references the workspace layout.
 */
export class DependencyRewriter
{
    public static readonly FileProtocol = 'file:';
    private static readonly CaretRange = '^';

    public constructor(private readonly reader: IManifestReader)
    {
    }

    public Rewrite(manifest: PackageManifest): IRewriteResult
    {
        const data = structuredClone(manifest.Data);
        const rewritten: IRewrittenDependency[] = [];
        for (const section of PackageManifest.Sections())
        {
            const dependencies = data[section];
            if (dependencies === undefined) continue;
            for (const [name, spec] of Object.entries(dependencies))
            {
                if (!DependencyRewriter.IsFileReference(spec)) continue;
                const target = this.reader.Read(path.resolve(manifest.Directory, spec.slice(DependencyRewriter.FileProtocol.length)));
                if (target.Name !== name)
                {
                    throw new Error(DependencyRewriter.NameMismatch(name, spec, target.Name));
                }
                const range = DependencyRewriter.CaretRange + target.Version;
                dependencies[name] = range;
                rewritten.push({ Section: section, Name: name, From: spec, To: range, Version: target.Version });
            }
        }
        const remaining = DependencyRewriter.FindFileReferences(data);
        if (remaining.length > 0)
        {
            throw new Error(DependencyRewriter.RemainingReferences(remaining));
        }
        return { Manifest: data, Rewritten: rewritten };
    }

    /** Every `section/name: spec` entry of the manifest that still is a `file:` reference. */
    public static FindFileReferences(data: IPackageManifestData): string[]
    {
        const found: string[] = [];
        for (const section of PackageManifest.Sections())
        {
            for (const [name, spec] of Object.entries(data[section] ?? {}))
            {
                if (DependencyRewriter.IsFileReference(spec)) found.push(`${section}/${name}: ${spec}`);
            }
        }
        return found;
    }

    public static IsFileReference(spec: string): boolean
    {
        return spec.startsWith(DependencyRewriter.FileProtocol);
    }

    private static NameMismatch(name: string, spec: string, actual: string): string
    {
        return `dependency ${name} (${spec}) points at package ${actual}`;
    }

    private static RemainingReferences(remaining: string[]): string
    {
        return `file: references remain after the rewrite: ${remaining.join(', ')}`;
    }
}
