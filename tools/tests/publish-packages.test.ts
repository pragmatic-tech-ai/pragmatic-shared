import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DependencyRewriter, IManifestReader } from '../publishing/dependency-rewriter.js';
import { IPackageManifestData, PackageManifest } from '../publishing/package-manifest.js';
import { PackageStager } from '../publishing/package-stager.js';

class FakeReader implements IManifestReader
{
    public readonly Requested: string[] = [];

    public constructor(private readonly byDirectory: Map<string, IPackageManifestData>)
    {
    }

    public Read(directory: string): PackageManifest
    {
        this.Requested.push(directory);
        const data = this.byDirectory.get(directory);
        if (data === undefined) throw new Error(`no manifest at ${directory}`);
        return new PackageManifest(directory, data);
    }
}

class Fixture
{
    public static readonly PackageDir = path.resolve('/ws/shared/packages/realm-gcp');
    public static readonly TodlDir = path.resolve('/ws/TODL');
    public static readonly RuntimeDir = path.resolve('/ws/todl-runtime');

    public static Reader(): FakeReader
    {
        return new FakeReader(new Map<string, IPackageManifestData>([
            [Fixture.TodlDir, { name: '@scope/todl', version: '0.66.2' }],
            [Fixture.RuntimeDir, { name: '@scope/todl-runtime', version: '0.7.0' }],
        ]));
    }

    public static Manifest(data: Partial<IPackageManifestData>): PackageManifest
    {
        return new PackageManifest(Fixture.PackageDir, { name: '@scope/realm-gcp', version: '0.1.0', ...data });
    }
}

describe('DependencyRewriter', () =>
{
    it('rewrites file: dependencies in every section to ^<target version>', () =>
    {
        const manifest = Fixture.Manifest({
            dependencies: { '@scope/todl': 'file:../../../TODL', 'pg': '8.23.1', '@scope/identity': '0.1.0' },
            devDependencies: { '@scope/todl-runtime': 'file:../../../todl-runtime' },
        });
        const result = new DependencyRewriter(Fixture.Reader()).Rewrite(manifest);
        assert.deepEqual(result.Manifest.dependencies, { '@scope/todl': '^0.66.2', 'pg': '8.23.1', '@scope/identity': '0.1.0' });
        assert.deepEqual(result.Manifest.devDependencies, { '@scope/todl-runtime': '^0.7.0' });
        assert.deepEqual(result.Rewritten.map(r => `${r.Section}/${r.Name}=${r.To}`), ['dependencies/@scope/todl=^0.66.2', 'devDependencies/@scope/todl-runtime=^0.7.0']);
    });

    it('resolves the target relative to the package directory', () =>
    {
        const reader = Fixture.Reader();
        new DependencyRewriter(reader).Rewrite(Fixture.Manifest({ peerDependencies: { '@scope/todl': 'file:../../../TODL' } }));
        assert.deepEqual(reader.Requested, [Fixture.TodlDir]);
    });

    it('does not modify the source manifest', () =>
    {
        const manifest = Fixture.Manifest({ dependencies: { '@scope/todl': 'file:../../../TODL' } });
        new DependencyRewriter(Fixture.Reader()).Rewrite(manifest);
        assert.equal(manifest.Data.dependencies?.['@scope/todl'], 'file:../../../TODL');
    });

    it('refuses a file: dependency that points at a differently named package', () =>
    {
        const manifest = Fixture.Manifest({ dependencies: { '@scope/other': 'file:../../../TODL' } });
        assert.throws(() => new DependencyRewriter(Fixture.Reader()).Rewrite(manifest), /points at package @scope\/todl/);
    });

    it('leaves a manifest without file: dependencies unchanged', () =>
    {
        const manifest = Fixture.Manifest({ dependencies: { 'pg': '8.23.1' }, optionalDependencies: { 'x': '^1.0.0' } });
        const result = new DependencyRewriter(Fixture.Reader()).Rewrite(manifest);
        assert.deepEqual(result.Manifest, manifest.Data);
        assert.equal(result.Rewritten.length, 0);
    });

    it('finds remaining file: references', () =>
    {
        const found = DependencyRewriter.FindFileReferences({ name: 'a', version: '1.0.0', optionalDependencies: { 'b': 'file:../b' }, dependencies: { 'c': '^1.0.0' } });
        assert.deepEqual(found, ['optionalDependencies/b: file:../b']);
    });
});

describe('PackageStager', () =>
{
    it('copies the files entries and README and writes the rewritten manifest', () =>
    {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stager-test-'));
        try
        {
            const packageDir = path.join(root, 'pkg');
            fs.mkdirSync(path.join(packageDir, 'dist', 'sub'), { recursive: true });
            fs.mkdirSync(path.join(packageDir, 'src'));
            fs.writeFileSync(path.join(packageDir, 'dist', 'sub', 'index.js'), 'export {};\n');
            fs.writeFileSync(path.join(packageDir, 'src', 'index.ts'), 'export {};\n');
            fs.utimesSync(path.join(packageDir, 'src', 'index.ts'), 1000, 1000);
            fs.writeFileSync(path.join(packageDir, 'README.md'), '# pkg\n');
            const manifest = new PackageManifest(packageDir, { name: '@scope/pkg', version: '1.0.0', files: ['dist', 'README.md'] });
            const staging = new PackageStager().Stage(manifest, { ...manifest.Data, dependencies: { 'a': '^1.0.0' } }, root);
            assert.ok(fs.existsSync(path.join(staging, 'dist', 'sub', 'index.js')));
            assert.ok(fs.existsSync(path.join(staging, 'README.md')));
            assert.ok(!fs.existsSync(path.join(staging, 'src')));
            const written = JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8')) as IPackageManifestData;
            assert.deepEqual(written.dependencies, { 'a': '^1.0.0' });
        }
        finally
        {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('refuses a package without a files list or with a missing entry', () =>
    {
        assert.throws(() => PackageStager.Entries(new PackageManifest('/x', { name: 'a', version: '1.0.0' })), /no "files" list/);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stager-test-'));
        try
        {
            const manifest = new PackageManifest(root, { name: 'a', version: '1.0.0', files: ['dist'] });
            assert.throws(() => new PackageStager().Stage(manifest, manifest.Data, root), /does not exist \(build first\)/);
        }
        finally
        {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
