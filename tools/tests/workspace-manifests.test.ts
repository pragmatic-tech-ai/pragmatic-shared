import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { DependencyRewriter, IManifestReader } from '../publishing/dependency-rewriter.js';
import { IPackageManifestData, PackageManifest } from '../publishing/package-manifest.js';

/** Reads a sibling's real manifest when present (local workspace), else a stand-in at a release version (CI). */
class SiblingReader implements IManifestReader
{
    public Read(directory: string): PackageManifest
    {
        try
        {
            return PackageManifest.Read(directory);
        }
        catch
        {
            const name = Object.entries(Workspace.Singletons).find(([, link]) => directory.endsWith(path.basename(link)))?.[0] ?? '';
            return new PackageManifest(directory, { name, version: '1.0.0' });
        }
    }
}

/** The workspace's package manifests, read from the root package.json's `workspaces`. */
/** Peers only a package's ./testing entry loads (pg-mem behind SqlTestSessions); never installed for production. */
class OptionalPeers
{
    private static readonly ByPackage: Record<string, string[]> = { 'pragmatic-realm-adapters': ['pg-mem'] };

    public static Of(name: string): string[]
    {
        return OptionalPeers.ByPackage[name] ?? [];
    }
}

class Workspace
{
    public static readonly Root = path.resolve(__dirname, '..', '..');
    public static readonly Scope = '@pragmatic-tech-ai/';
    public static readonly License = 'Apache-2.0';
    /** Packages a consumer must hold exactly one copy of: an object from one copy fails `instanceof` against the other. */
    public static readonly Singletons: Record<string, string> = {
        '@pragmatic-tech-ai/todl': '../../../TODL',
        '@pragmatic-tech-ai/todl-runtime': '../../../todl-runtime',
        '@pragmatic-tech-ai/mural': '../../../Mural',
    };

    public static Packages(): PackageManifest[]
    {
        const root = PackageManifest.Read(Workspace.Root).Data as IPackageManifestData & { workspaces: string[] };
        return root.workspaces.map(workspace => PackageManifest.Read(path.join(Workspace.Root, workspace)));
    }
}

describe('workspace manifests', () =>
{
    const packages = Workspace.Packages();

    it('lists the fifteen packages', () =>
    {
        assert.equal(packages.length, 15);
    });

    it('takes todl, todl-runtime and mural as peer dependencies linked to the sibling checkout, never as dependencies', () =>
    {
        for (const manifest of packages)
        {
            for (const [singleton, link] of Object.entries(Workspace.Singletons))
            {
                assert.equal(manifest.Data.dependencies?.[singleton], undefined, `${manifest.Name}: ${singleton} is a dependency (consumers would get a nested second copy)`);
                // A dev entry would flag the link dev, and the images' `npm ci --omit=dev` would drop it.
                assert.equal(manifest.Data.devDependencies?.[singleton], undefined, `${manifest.Name}: ${singleton} is a devDependency`);
                const peer = manifest.Data.peerDependencies?.[singleton];
                if (peer !== undefined) assert.equal(peer, 'file:' + link, `${manifest.Name}: peer ${singleton}`);
            }
        }
    });

    it('publishes each singleton peer as a caret range of the sibling version', () =>
    {
        const rewriter = new DependencyRewriter(new SiblingReader());
        for (const manifest of packages)
        {
            const published = rewriter.Rewrite(manifest).Manifest;
            for (const [singleton, spec] of Object.entries(published.peerDependencies ?? {}))
            {
                assert.match(spec, /^\^\d+\.\d+\.\d+$/, `${manifest.Name}: published peer ${singleton}`);
            }
        }
    });

    it('declares every singleton a package imports as a required peer; test-only peers are optional', () =>
    {
        const expected: Record<string, string[]> = {
            'pragmatic-identity': ['@pragmatic-tech-ai/todl-runtime'],
            'pragmatic-component': [],
            'pragmatic-identity-store': ['@pragmatic-tech-ai/todl-runtime'],
            'pragmatic-realm-adapters': ['@pragmatic-tech-ai/todl', '@pragmatic-tech-ai/todl-runtime'],
            'pragmatic-realm-custom': ['@pragmatic-tech-ai/todl', '@pragmatic-tech-ai/todl-runtime'],
            'pragmatic-realm-gcp': ['@pragmatic-tech-ai/todl', '@pragmatic-tech-ai/todl-runtime'],
            'pragmatic-realm-aws': ['@pragmatic-tech-ai/todl', '@pragmatic-tech-ai/todl-runtime'],
            'pragmatic-realm-azure': ['@pragmatic-tech-ai/todl', '@pragmatic-tech-ai/todl-runtime'],
            'pragmatic-app-host': ['@pragmatic-tech-ai/todl', '@pragmatic-tech-ai/todl-runtime'],
            'pragmatic-app-shell': ['@pragmatic-tech-ai/mural', '@pragmatic-tech-ai/todl-runtime'],
        };
        for (const [name, singletons] of Object.entries(expected))
        {
            const manifest = packages.find(candidate => candidate.Name === Workspace.Scope + name);
            assert.ok(manifest !== undefined, name);
            const optional = manifest.Data.peerDependenciesMeta ?? {};
            const peers = Object.keys(manifest.Data.peerDependencies ?? {});
            assert.deepEqual(peers.filter(peer => optional[peer]?.optional !== true).sort(), singletons, name);
            assert.deepEqual(peers.filter(peer => optional[peer]?.optional === true).sort(), OptionalPeers.Of(name), name);
        }
    });

    it('carries one version, pinned by every workspace dependency on a sibling package', () =>
    {
        const version = packages[0].Version;
        const names = new Set(packages.map(manifest => manifest.Name));
        for (const manifest of packages)
        {
            assert.equal(manifest.Version, version, manifest.Name);
            for (const section of PackageManifest.Sections())
            {
                for (const [name, spec] of Object.entries(manifest.Data[section] ?? {}))
                {
                    if (names.has(name)) assert.equal(spec, version, `${manifest.Name}: ${section}/${name}`);
                }
            }
        }
    });

    it('declares the Apache-2.0 license on every package', () =>
    {
        for (const manifest of packages)
        {
            assert.equal(manifest.Data.license, Workspace.License, manifest.Name);
        }
    });
});
