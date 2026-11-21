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

    it('writes the render arguments into package.json, re-renders from them without flags, and check finds no drift', () =>
    {
        const out = CliFixture.Out('render-args')
        mkdirSync(out, { recursive: true })
        writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0' }, null, 2) + '\n')
        const flags = ['render', '--app', 'pragmatic-tenant-idp', '--entry', 'src/bin/pragmatic-idpd.ts', '--ui', 'idp-login', '--gitignore', 'data/', '--out', out]
        assert.equal(CliFixture.Run(flags).Code, 0)
        const manifest = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'))
        assert.deepEqual(manifest.pragmaticContainerTemplate, { App: 'pragmatic-tenant-idp', Entry: 'src/bin/pragmatic-idpd.ts', UiDirs: ['idp-login'], GitIgnore: ['data/'] })
        const dockerfile = readFileSync(join(out, 'Dockerfile'), 'utf8')
        writeFileSync(join(out, 'Dockerfile'), 'hand edit\n')
        assert.equal(CliFixture.Run(['render', '--out', out]).Code, 0)
        assert.equal(readFileSync(join(out, 'Dockerfile'), 'utf8'), dockerfile, 'the field alone re-renders the same files')
        const check = CliFixture.Run(['check', '--out', out])
        assert.equal(check.Code, 0, check.Err.join('\n'))
        assert.deepEqual(check.Out, ['The rendered files match the template'])
    })

    it('check names every drifted file (a hand edit, a missing file, a stale package.json field) and exits 1', () =>
    {
        const out = CliFixture.Out('drift')
        mkdirSync(out, { recursive: true })
        writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'x' }, null, 2) + '\n')
        assert.equal(CliFixture.Run(['render', '--app', 'pragmatic-hive-agent', '--entry', 'src/bin/pragmatic-agentd.ts', '--out', out]).Code, 0)
        writeFileSync(join(out, '.dockerignore'), 'edited\n')
        rmSync(join(out, 'docker-bake.hcl'))
        const manifest = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'))
        manifest.pragmaticClosureCheck = { Apps: ['other'] }
        writeFileSync(join(out, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
        const check = CliFixture.Run(['check', '--out', out])
        assert.equal(check.Code, 1)
        assert.deepEqual(check.Err.filter(line => line.startsWith('drift: ')).sort(), ['drift: .dockerignore', 'drift: docker-bake.hcl', 'drift: package.json'])
    })

    it('check reads CRLF checkouts as LF, names a directory where a file goes and an unparseable package.json as drift', () =>
    {
        const out = CliFixture.Out('crlf')
        mkdirSync(out, { recursive: true })
        writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'x' }, null, 2) + '\n')
        assert.equal(CliFixture.Run(['render', '--app', 'pragmatic-hive-agent', '--entry', 'src/bin/pragmatic-agentd.ts', '--out', out]).Code, 0)
        const ignore = join(out, '.dockerignore')
        writeFileSync(ignore, readFileSync(ignore, 'utf8').replace(/\n/g, '\r\n'))
        assert.equal(CliFixture.Run(['check', '--out', out]).Code, 0, 'a CRLF checkout is not drift')
        rmSync(join(out, 'tsconfig.json'))
        mkdirSync(join(out, 'tsconfig.json'))
        const directory = CliFixture.Run(['check', '--out', out])
        assert.equal(directory.Code, 1)
        assert.ok(directory.Err.includes('drift: tsconfig.json'))
        rmSync(join(out, 'tsconfig.json'), { recursive: true })
        const manifest = readFileSync(join(out, 'package.json'), 'utf8')
        writeFileSync(join(out, 'package.json'), manifest.slice(0, -3))
        const broken = CliFixture.Run(['check', '--out', out])
        assert.equal(broken.Code, 1)
        assert.ok(broken.Err.includes('drift: package.json (unparseable)'), broken.Err.join('\n'))
    })

    it('drops a stale closure check field where the image is not a Node closure (pragmatic-postgres)', () =>
    {
        const out = CliFixture.Out('postgres')
        mkdirSync(out, { recursive: true })
        writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'x', pragmaticClosureCheck: { Apps: ['pragmatic-postgres'] } }, null, 2) + '\n')
        assert.equal(CliFixture.Run(['check', '--out', out]).Code, 2, 'no render arguments yet')
        assert.equal(CliFixture.Run(['render', '--app', 'pragmatic-postgres', '--entry', 'Dockerfile', '--out', out]).Code, 0)
        const manifest = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'))
        assert.equal(manifest.pragmaticClosureCheck, undefined)
        assert.deepEqual(manifest.pragmaticContainerTemplate, { App: 'pragmatic-postgres', Entry: 'Dockerfile' })
        assert.equal(CliFixture.Run(['check', '--out', out]).Code, 0)
    })

    it('check and a flagless render refuse a repository without render arguments, and an ill-shaped field', () =>
    {
        const out = CliFixture.Out('no-args')
        mkdirSync(out, { recursive: true })
        writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'x' }))
        assert.equal(CliFixture.Run(['check', '--out', out]).Code, 2)
        assert.equal(CliFixture.Run(['render', '--out', out]).Code, 2)
        assert.equal(CliFixture.Run(['check', '--out', out, '--app', 'pragmatic-hive-agent']).Code, 2)
        writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'x', pragmaticContainerTemplate: { App: 'pragmatic-hive-agent', Entry: 1 } }))
        assert.equal(CliFixture.Run(['check', '--out', out]).Code, 1)
        writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'x', pragmaticContainerTemplate: { App: 'pragmatic-hive-agent', Entry: 'src/a.ts', Extra: true } }))
        assert.equal(CliFixture.Run(['check', '--out', out]).Code, 1)
        for (const bad of [{ Entry: '' }, { Assets: [{ From: '', To: 'dist/x' }] }, { Assets: [{ From: 'a', To: 'b', Mode: 1 }] }])
        {
            writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'x', pragmaticContainerTemplate: { App: 'pragmatic-hive-agent', Entry: 'src/a.ts', ...bad } }))
            assert.equal(CliFixture.Run(['check', '--out', out]).Code, 1, JSON.stringify(bad))
        }
    })

    it('takes --writable more than once and keeps the directories in the render arguments, re-rendered without flags', () =>
    {
        const out = CliFixture.Out('writable')
        mkdirSync(out, { recursive: true })
        writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0' }, null, 2) + '\n')
        const render = CliFixture.Run(['render', '--app', 'pragmatic-hive-agent', '--entry', 'src/bin/pragmatic-agentd.ts', '--writable', 'dist/a', '--writable', 'cache', '--out', out])
        assert.equal(render.Code, 0, render.Err.join('\n'))
        const manifest = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'))
        assert.deepEqual(manifest.pragmaticContainerTemplate.WritableDirs, ['dist/a', 'cache'])
        const owned = 'chown 10001:10001 /workspace/pragmatic-hive-agent/dist/a /workspace/pragmatic-hive-agent/cache\n'
        assert.ok(readFileSync(join(out, 'Dockerfile'), 'utf8').includes(owned))
        assert.equal(CliFixture.Run(['check', '--out', out]).Code, 0)
        writeFileSync(join(out, 'Dockerfile'), 'hand edit\n')
        assert.equal(CliFixture.Run(['render', '--out', out]).Code, 0)
        assert.ok(readFileSync(join(out, 'Dockerfile'), 'utf8').includes(owned), 'the field alone re-renders them')
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
        const last = result.Out.at(-1) ?? ''
        assert.ok(last.includes('"pragmaticClosureCheck":{"Manifest":"closure.json","Dockerfile":"Dockerfile","Apps":["pragmatic-hive-agent"]}'), last)
        assert.ok(last.includes('"pragmaticContainerTemplate":{"App":"pragmatic-hive-agent","Entry":"src/bin/pragmatic-agentd.ts"}'), last)
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
