import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ComponentDescriptorBuilder, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { ComponentDescriptorCli } from '../../release/component-descriptor-cli.js'
import { ReleaseApp } from '../../release/release-tag.js'
import { ContainerComponentSource } from '../container-component-source.js'
import { ContainerTemplateCli } from '../container-template-cli.js'
import { ContainerTemplateError } from '../container-template-error.js'
import { ContainerWorkspaces } from '../container-workspaces.js'

class CliFixture
{
    public static readonly Scratch = mkdtempSync(join(tmpdir(), 'container-template-'))
    public static readonly Version = '0.1.0'

    public static Run(argv: readonly string[]): { Code: number; Out: string[]; Err: string[] }
    {
        const out: string[] = []
        const err: string[] = []
        const code = ContainerTemplateCli.Run(argv, { Out: line => out.push(line), Err: line => err.push(line) })
        return { Code: code, Out: out, Err: err }
    }

    public static Out(name: string): string
    {
        return join(CliFixture.Scratch, name)
    }

    public static Descriptor(app: ReleaseApp): ComponentDescriptor
    {
        return new ComponentDescriptorBuilder(app, CliFixture.Version).Build()
    }
}

describe('ContainerTemplateCli', () =>
{
    after(() => rmSync(CliFixture.Scratch, { recursive: true, force: true }))

    it('render writes every rendered file under --out and lists them', () =>
    {
        const out = CliFixture.Out('idp')
        const result = CliFixture.Run(['render', '--app', 'pragmatic-tenant-idp', '--entry', 'src/bin/pragmatic-idpd.ts', '--ui', 'idp-login', '--out', out])
        assert.equal(result.Code, 0, result.Err.join('\n'))
        for (const path of ['Dockerfile', 'docker-bake.hcl', '.npmrc', '.gitattributes', '.gitignore', '.dockerignore', 'tsconfig.json', 'tsconfig.build.json', '.github/workflows/ci.yml', '.github/workflows/release.yml'])
        {
            assert.ok(existsSync(join(out, path)), path)
            assert.ok(result.Out.includes(path), path)
        }
        assert.ok(readFileSync(join(out, 'Dockerfile'), 'utf8').includes('ENTRYPOINT ["node", "dist/bin/pragmatic-idpd.js"]'))
    })

    it('takes --dockerignore more than once, appending each line to the .dockerignore in order', () =>
    {
        const out = CliFixture.Out('ignores')
        const result = CliFixture.Run(['render', '--app', 'pragmatic-hive-agent', '--entry', 'src/bin/pragmatic-agentd.ts',
            '--dockerignore', '**/*.local.json', '--dockerignore', 'secrets/', '--out', out])
        assert.equal(result.Code, 0, result.Err.join('\n'))
        assert.ok(readFileSync(join(out, '.dockerignore'), 'utf8').endsWith('test-results\n**/*.local.json\nsecrets/\n'))
    })

    it('takes --gitignore more than once, appending each line to the .gitignore in order', () =>
    {
        const out = CliFixture.Out('gitignores')
        const result = CliFixture.Run(['render', '--app', 'pragmatic-hive-agent', '--entry', 'src/bin/pragmatic-agentd.ts',
            '--gitignore', '# Local secrets.', '--gitignore', 'secrets/', '--out', out])
        assert.equal(result.Code, 0, result.Err.join('\n'))
        assert.ok(readFileSync(join(out, '.gitignore'), 'utf8').endsWith('test-results/\n# Local secrets.\nsecrets/\n'))
    })

    it('takes --ui and --copy more than once, in order', () =>
    {
        const out = CliFixture.Out('admin')
        const result = CliFixture.Run(['render', '--app', 'pragmatic-platform-admin', '--entry', 'src/server.ts', '--ui', 'portal', '--ui', 'console',
            '--copy', 'release-keys', '--copy', 'environments/demo', '--out', out])
        assert.equal(result.Code, 0, result.Err.join('\n'))
        const dockerfile = readFileSync(join(out, 'Dockerfile'), 'utf8')
        const order = ['/portal/dist ', '/console/dist ', '/release-keys ', '/environments/demo '].map(path => dockerfile.indexOf(path))
        assert.ok(order.every(index => index > 0))
        assert.deepEqual([...order].sort((a, b) => a - b), order)
        assert.match(readFileSync(join(out, '.github/workflows/ci.yml'), 'utf8'), /ui-dirs: 'portal console'/)
    })

    it('prints the pragmaticClosureCheck field when the repository has no package.json yet', () =>
    {
        const result = CliFixture.Run(['render', '--app', 'pragmatic-hive-agent', '--entry', 'src/bin/pragmatic-agentd.ts', '--out', CliFixture.Out('fresh')])
        assert.equal(result.Code, 0, result.Err.join('\n'))
        assert.equal(existsSync(join(CliFixture.Out('fresh'), 'package.json')), false)
        assert.ok(result.Out.at(-1)?.endsWith('"pragmaticClosureCheck": {"Manifest":"closure.json","Dockerfile":"Dockerfile","Apps":["pragmatic-hive-agent"]}'), result.Out.at(-1))
    })

    it('reads the workspaces from the repository package.json and merges the pragmaticClosureCheck field into it', () =>
    {
        const out = CliFixture.Out('workspaces')
        for (const workspace of ['server', 'packages/b', 'packages/a'])
        {
            mkdirSync(join(out, workspace), { recursive: true })
            writeFileSync(join(out, workspace, 'package.json'), '{}')
        }
        mkdirSync(join(out, 'packages', 'not-a-package'))
        writeFileSync(join(out, 'package.json'), JSON.stringify({ name: '@pragmatic-tech-ai/pragmatic-env-server', version: '0.1.0', workspaces: ['server', 'packages/*'] }))
        const result = CliFixture.Run(['render', '--app', 'pragmatic-env-server', '--entry', 'server/src/bin/pragmatic-serverd.ts', '--out', out])
        assert.equal(result.Code, 0, result.Err.join('\n'))
        const manifest = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')) as Record<string, unknown>
        assert.equal(manifest.version, '0.1.0')
        assert.deepEqual(manifest.workspaces, ['server', 'packages/*'])
        assert.deepEqual(manifest.pragmaticClosureCheck, {
            Manifest: 'closure.json', Dockerfile: 'Dockerfile', Apps: ['pragmatic-env-server'],
            CompiledRoots: [['server/dist/', 'server/src/'], ['packages/a/dist/', 'packages/a/src/'], ['packages/b/dist/', 'packages/b/src/']],
        })
        assert.ok(result.Out.includes('package.json'))
        const dockerfile = readFileSync(join(out, 'Dockerfile'), 'utf8')
        assert.ok(dockerfile.includes('COPY packages/a/package.json packages/a/package.json\nCOPY packages/b/package.json packages/b/package.json'))
        assert.ok(!dockerfile.includes('not-a-package'))
    })

    it('takes --asset <from>=<to> more than once and refuses one without both sides', () =>
    {
        const out = CliFixture.Out('assets')
        const result = CliFixture.Run(['render', '--app', 'pragmatic-tenant-admin', '--entry', 'src/bin/pragmatic-tenant-admind.ts',
            '--asset', 'src/templates=dist/templates', '--asset', 'descriptors=dist/descriptors', '--out', out])
        assert.equal(result.Code, 0, result.Err.join('\n'))
        const dockerfile = readFileSync(join(out, 'Dockerfile'), 'utf8')
        assert.ok(dockerfile.indexOf('cp -r src/templates dist/templates') < dockerfile.indexOf('cp -r descriptors dist/descriptors'))
        for (const asset of ['src/templates', '=dist/x', 'src/x='])
        {
            assert.equal(CliFixture.Run(['render', '--app', 'pragmatic-tenant-admin', '--entry', 'src/a.ts', '--asset', asset, '--out', CliFixture.Out('bad-asset')]).Code, 2, asset)
        }
        assert.equal(existsSync(CliFixture.Out('bad-asset')), false)
    })

    it('checks every target before writing: a directory where a file goes writes nothing', () =>
    {
        const out = CliFixture.Out('blocked')
        mkdirSync(join(out, 'tsconfig.json'), { recursive: true })
        const result = CliFixture.Run(['render', '--app', 'pragmatic-hive-agent', '--entry', 'src/bin/pragmatic-agentd.ts', '--out', out])
        assert.equal(result.Code, 1)
        assert.match(result.Err[0], /tsconfig\.json/)
        assert.deepEqual(readdirSync(out), ['tsconfig.json'])
        const under = CliFixture.Out('under-file')
        mkdirSync(under)
        writeFileSync(join(under, '.github'), 'a file')
        assert.equal(CliFixture.Run(['render', '--app', 'pragmatic-hive-agent', '--entry', 'src/bin/pragmatic-agentd.ts', '--out', under]).Code, 1)
        assert.deepEqual(readdirSync(under), ['.github'])
    })

    it('refuses a missing command, an unknown option and a repeated single option with the usage exit code', () =>
    {
        for (const argv of [
            [],
            ['build', '--app', 'pragmatic-hive-agent'],
            ['render', '--app', 'pragmatic-hive-agent', '--entry', 'src/a.ts', '--out', CliFixture.Out('x'), '--force', 'yes'],
            ['render', '--app', 'pragmatic-hive-agent', '--app', 'pragmatic-ui-unpack', '--entry', 'src/a.ts', '--out', CliFixture.Out('x')],
            ['render', '--app', 'pragmatic-hive-agent', '--entry'],
        ])
        {
            const result = CliFixture.Run(argv)
            assert.equal(result.Code, 2, JSON.stringify(argv))
            assert.equal(result.Err.length, 1)
        }
    })

    it('refuses a missing --app, --entry or --out', () =>
    {
        for (const [argv, flag] of [
            [['render', '--entry', 'src/a.ts', '--out', CliFixture.Out('y')], '--app'],
            [['render', '--app', 'pragmatic-hive-agent', '--out', CliFixture.Out('y')], '--entry'],
            [['render', '--app', 'pragmatic-hive-agent', '--entry', 'src/a.ts'], '--out'],
        ] as const)
        {
            const result = CliFixture.Run(argv)
            assert.equal(result.Code, 2)
            assert.ok(result.Err[0].endsWith(flag), result.Err[0])
        }
        assert.equal(existsSync(CliFixture.Out('y')), false)
    })

    it('refuses an unknown app and a bad entry, writing nothing', () =>
    {
        const unknown = CliFixture.Run(['render', '--app', 'pragmatic-unknown', '--entry', 'src/a.ts', '--out', CliFixture.Out('z')])
        assert.equal(unknown.Code, 2)
        assert.match(unknown.Err[0], /pragmatic-unknown/)
        const bad = CliFixture.Run(['render', '--app', 'pragmatic-hive-agent', '--entry', 'lib/a.js', '--out', CliFixture.Out('z')])
        assert.equal(bad.Code, 1)
        assert.match(bad.Err[0], /lib\/a\.js/)
        assert.equal(existsSync(CliFixture.Out('z')), false)
    })
})

describe('ContainerComponentSource', () =>
{
    it('declares its one app, refuses any other', () =>
    {
        const source = new ContainerComponentSource(ReleaseApp.HiveAgent, () => CliFixture.Descriptor(ReleaseApp.HiveAgent))
        assert.equal(source.Of(ReleaseApp.HiveAgent).Name, ReleaseApp.HiveAgent)
        assert.deepEqual(source.All().map(([app]) => app), [ReleaseApp.HiveAgent])
        assert.throws(() => source.Of(ReleaseApp.UiUnpack), /pragmatic-ui-unpack/)
    })

    it('refuses a descriptor named for another component', () =>
    {
        const source = new ContainerComponentSource(ReleaseApp.HiveAgent, () => CliFixture.Descriptor(ReleaseApp.UiUnpack))
        assert.throws(() => source.Of(ReleaseApp.HiveAgent), /pragmatic-ui-unpack/)
    })

    it('emit-all writes the bake override for the image target named after the app', () =>
    {
        const out = CliFixture.Out('components')
        const source = new ContainerComponentSource(ReleaseApp.TenantIdp, () => CliFixture.Descriptor(ReleaseApp.TenantIdp))
        const silent = { Out: (_line: string) => undefined, Err: (_line: string) => undefined }
        assert.equal(ComponentDescriptorCli.Run(['emit-all', '--out', out], silent, source), 0)
        const override = JSON.parse(readFileSync(join(out, ComponentDescriptorCli.BakeFile), 'utf8')) as { target: Record<string, { args: Record<string, string> }> }
        assert.deepEqual(Object.keys(override.target), [ReleaseApp.TenantIdp])
        assert.equal(override.target[ReleaseApp.TenantIdp].args.COMPONENT_DIGEST, CliFixture.Descriptor(ReleaseApp.TenantIdp).ContentDigest())
        assert.ok(existsSync(join(out, ReleaseApp.TenantIdp, ComponentDescriptorCli.DescriptorFile)))
    })
})

describe('ContainerWorkspaces', () =>
{
    it('reads none without a package.json or a workspaces field, the { packages } form, and refuses other globs', () =>
    {
        const root = CliFixture.Out('workspaces-read')
        mkdirSync(join(root, 'tools'), { recursive: true })
        assert.deepEqual(ContainerWorkspaces.Read(root), [])
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x' }))
        assert.deepEqual(ContainerWorkspaces.Read(root), [])
        writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: { packages: ['tools/'] } }))
        assert.deepEqual(ContainerWorkspaces.Read(root), ['tools'])
        for (const field of [['packages/**'], ['pack*/x'], 'server', [1]])
        {
            writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: field }))
            assert.throws(() => ContainerWorkspaces.Read(root), ContainerTemplateError, JSON.stringify(field))
        }
    })
})
