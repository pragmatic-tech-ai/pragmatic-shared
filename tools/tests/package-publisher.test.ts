import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IPackageManifestData } from '../publishing/package-manifest.js';
import { PackagePublisher, PublishOutcome } from '../publishing/package-publisher.js';
import { IProcessResult, IProcessRunner, NpmProcessRunner } from '../publishing/process-runner.js';
import { IRegistryLookup, NpmRegistryLookup } from '../publishing/registry-lookup.js';

class FakeRunner implements IProcessRunner
{
    public readonly Calls: { Args: string[]; Cwd: string; StagedFiles: string[] }[] = [];

    public constructor(private readonly status: number = 0, private readonly stdout: string = '')
    {
    }

    public Run(args: string[], cwd: string): IProcessResult
    {
        const stagedFiles = fs.existsSync(cwd) ? fs.readdirSync(cwd).sort() : [];
        this.Calls.push({ Args: args, Cwd: cwd, StagedFiles: stagedFiles });
        return { Status: this.status, Stdout: this.stdout };
    }
}

class FakeRegistry implements IRegistryLookup
{
    public readonly Asked: string[] = [];

    public constructor(private readonly published: string[])
    {
    }

    public Exists(id: string): boolean
    {
        this.Asked.push(id);
        return this.published.includes(id);
    }
}

/** A built package on disk (dist newer than src) beside a `file:` dependency target `../todl` at 0.66.2. */
class PackageOnDisk
{
    public readonly Root = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-test-'));
    public readonly Directory = path.join(this.Root, 'pkg');

    public constructor(dependencies: Partial<IPackageManifestData>)
    {
        const target = path.join(this.Root, 'todl');
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: '@scope/todl', version: '0.66.2' }));
        fs.mkdirSync(path.join(this.Directory, 'src'), { recursive: true });
        fs.writeFileSync(path.join(this.Directory, 'src', 'index.ts'), 'export {};\n');
        this.Touch(path.join('src', 'index.ts'), 1000);
        fs.mkdirSync(path.join(this.Directory, 'dist'));
        fs.writeFileSync(path.join(this.Directory, 'dist', 'index.js'), 'export {};\n');
        this.Touch(path.join('dist', 'index.js'), 2000);
        fs.writeFileSync(path.join(this.Directory, 'package.json'), JSON.stringify({ name: '@scope/pkg', version: '0.1.1', files: ['dist'], ...dependencies }));
    }

    public Touch(relative: string, seconds: number): void
    {
        fs.utimesSync(path.join(this.Directory, relative), seconds, seconds);
    }

    public Dispose(): void
    {
        fs.rmSync(this.Root, { recursive: true, force: true });
    }
}

class Silent
{
    public static Log(): void
    {
    }
}

describe('NpmProcessRunner and NpmRegistryLookup', () =>
{
    it('quotes every argument, not the command, of the npm command line', () =>
    {
        assert.equal(NpmProcessRunner.CommandLine(['pack', '--pack-destination', 'C:\\a b']), 'npm "pack" "--pack-destination" "C:\\a b"');
    });

    it('asks npm view for name@version on the given registry', () =>
    {
        const runner = new FakeRunner(0, '0.1.1\n');
        assert.equal(new NpmRegistryLookup(runner, PackagePublisher.Registry).Exists('@scope/pkg@0.1.1'), true);
        assert.deepEqual(runner.Calls[0].Args, ['view', '@scope/pkg@0.1.1', 'version', '--registry', PackagePublisher.Registry]);
        assert.equal(new NpmRegistryLookup(new FakeRunner(1, ''), PackagePublisher.Registry).Exists('@scope/pkg@0.1.1'), false);
        assert.equal(new NpmRegistryLookup(new FakeRunner(0, ''), PackagePublisher.Registry).Exists('@scope/pkg@0.1.1'), false);
    });
});

describe('PackagePublisher', () =>
{
    it('skips a name@version that is already published without staging or running npm', () =>
    {
        const disk = new PackageOnDisk({});
        try
        {
            const runner = new FakeRunner();
            const outcome = new PackagePublisher(false, Silent.Log, runner, new FakeRegistry(['@scope/pkg@0.1.1'])).Publish(disk.Directory);
            assert.equal(outcome, PublishOutcome.AlreadyPublished);
            assert.equal(runner.Calls.length, 0);
        }
        finally
        {
            disk.Dispose();
        }
    });

    it('publishes the staged copy with scripts ignored and removes the staging folder', () =>
    {
        const disk = new PackageOnDisk({ devDependencies: { '@scope/todl': 'file:../todl' } });
        try
        {
            const runner = new FakeRunner();
            const outcome = new PackagePublisher(false, Silent.Log, runner, new FakeRegistry([])).Publish(disk.Directory);
            assert.equal(outcome, PublishOutcome.Published);
            assert.equal(runner.Calls.length, 1);
            assert.deepEqual(runner.Calls[0].Args, ['publish', '--ignore-scripts', '--registry', PackagePublisher.Registry]);
            assert.deepEqual(runner.Calls[0].StagedFiles, ['dist', 'package.json']);
            assert.ok(!fs.existsSync(runner.Calls[0].Cwd), 'staging folder removed');
        }
        finally
        {
            disk.Dispose();
        }
    });

    it('removes the staging folder when npm publish fails', () =>
    {
        const disk = new PackageOnDisk({});
        try
        {
            const runner = new FakeRunner(1);
            assert.throws(() => new PackagePublisher(false, Silent.Log, runner, new FakeRegistry([])).Publish(disk.Directory), /npm publish failed/);
            assert.equal(runner.Calls.length, 1);
            assert.ok(!fs.existsSync(runner.Calls[0].Cwd), 'staging folder removed');
        }
        finally
        {
            disk.Dispose();
        }
    });

    it('packs into the staging folder in a dry run without asking whether the package is published', () =>
    {
        const disk = new PackageOnDisk({});
        try
        {
            const runner = new FakeRunner();
            const registry = new FakeRegistry([]);
            assert.equal(new PackagePublisher(true, Silent.Log, runner, registry).Publish(disk.Directory), PublishOutcome.Packed);
            assert.deepEqual(runner.Calls[0].Args, ['pack', '--ignore-scripts', '--pack-destination', runner.Calls[0].Cwd]);
            assert.deepEqual(registry.Asked, []);
            fs.rmSync(runner.Calls[0].Cwd, { recursive: true, force: true });
        }
        finally
        {
            disk.Dispose();
        }
    });

    for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies'])
    {
        it(`refuses a rewritten ${section} entry whose target version is not on the registry`, () =>
        {
            const disk = new PackageOnDisk({ [section]: { '@scope/todl': 'file:../todl' } });
            try
            {
                const runner = new FakeRunner();
                const registry = new FakeRegistry([]);
                assert.throws(() => new PackagePublisher(false, Silent.Log, runner, registry).Publish(disk.Directory), /not on the registry .*@scope\/todl@0\.66\.2/);
                assert.ok(registry.Asked.includes('@scope/todl@0.66.2'));
                assert.equal(runner.Calls.length, 0);
            }
            finally
            {
                disk.Dispose();
            }
        });
    }

    it('publishes a rewritten dependency whose target version is on the registry, and checks it in a dry run too', () =>
    {
        const disk = new PackageOnDisk({ dependencies: { '@scope/todl': 'file:../todl' } });
        try
        {
            const runner = new FakeRunner();
            assert.equal(new PackagePublisher(false, Silent.Log, runner, new FakeRegistry(['@scope/todl@0.66.2'])).Publish(disk.Directory), PublishOutcome.Published);
            assert.throws(() => new PackagePublisher(true, Silent.Log, new FakeRunner(), new FakeRegistry([])).Publish(disk.Directory), /not on the registry/);
        }
        finally
        {
            disk.Dispose();
        }
    });

    it('does not check devDependencies against the registry', () =>
    {
        const disk = new PackageOnDisk({ devDependencies: { '@scope/todl': 'file:../todl' } });
        try
        {
            const registry = new FakeRegistry([]);
            new PackagePublisher(false, Silent.Log, new FakeRunner(), registry).Publish(disk.Directory);
            assert.deepEqual(registry.Asked, ['@scope/pkg@0.1.1']);
        }
        finally
        {
            disk.Dispose();
        }
    });

    it('refuses a dist older than a source file and accepts it once rebuilt; test files do not count', () =>
    {
        const disk = new PackageOnDisk({});
        try
        {
            const runner = new FakeRunner();
            disk.Touch(path.join('src', 'index.ts'), 3000);
            assert.throws(() => new PackagePublisher(false, Silent.Log, runner, new FakeRegistry([])).Publish(disk.Directory), /dist.index\.js is older than src.index\.ts \(build first\)/);
            assert.equal(runner.Calls.length, 0);
            disk.Touch(path.join('dist', 'index.js'), 4000);
            fs.mkdirSync(path.join(disk.Directory, 'src', 'tests'));
            fs.writeFileSync(path.join(disk.Directory, 'src', 'tests', 'index.test.ts'), 'export {};\n');
            disk.Touch(path.join('src', 'tests', 'index.test.ts'), 5000);
            assert.equal(new PackagePublisher(false, Silent.Log, runner, new FakeRegistry([])).Publish(disk.Directory), PublishOutcome.Published);
        }
        finally
        {
            disk.Dispose();
        }
    });
});
