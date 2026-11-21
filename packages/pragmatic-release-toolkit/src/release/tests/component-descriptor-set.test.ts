import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ComponentDescriptorBuilder, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { ComponentDescriptorCli, type IReleaseComponentSource } from '../component-descriptor-cli.js'
import { ComponentDescriptorSet, ComponentDescriptorSetDigestError } from '../component-descriptor-set.js'
import { ReleaseApp } from '../release-tag.js'

/** Two apps' descriptors, as a container repository's (or the monorepo's) declaration classes would build them. */
class TwoComponents implements IReleaseComponentSource
{
    public static readonly Version = '0.1.0'
    public static readonly Apps: readonly ReleaseApp[] = [ReleaseApp.HiveAgent, ReleaseApp.UiUnpack]

    public Of(app: ReleaseApp): ComponentDescriptor
    {
        return new ComponentDescriptorBuilder(app, TwoComponents.Version).Build()
    }

    public All(): [ReleaseApp, ComponentDescriptor][]
    {
        return TwoComponents.Apps.map(app => [app, this.Of(app)])
    }
}

class SetFixture
{
    public static readonly Scratch = mkdtempSync(join(tmpdir(), 'descriptor-set-'))
    public static readonly Utf8 = 'utf8'
    public static readonly Other = '9.9.9'
    public static readonly Unknown = 'pragmatic-unknown'
    public static readonly Silent = { Out: (_line: string) => undefined, Err: (_line: string) => undefined }

    public static Vendored(name: string): string
    {
        const dir = join(SetFixture.Scratch, name)
        assert.equal(ComponentDescriptorCli.Run(['vendor', '--out', dir], SetFixture.Silent, new TwoComponents()), 0)
        return dir
    }
}

describe('ComponentDescriptorSet', () =>
{
    after(() => rmSync(SetFixture.Scratch, { recursive: true, force: true }))

    it('loads a vendored set and every descriptor hashes to its pin', () =>
    {
        const set = ComponentDescriptorSet.FromDirectory(SetFixture.Vendored('ok'))
        assert.deepEqual(set.All().map(d => d.Name).sort(), [...TwoComponents.Apps].sort())
        for (const [app, declared] of new TwoComponents().All())
        {
            assert.equal(set.Get(app)?.ContentDigest(), declared.ContentDigest(), app)
        }
    })

    it('refuses a file whose content does not hash to its pinned digest', () =>
    {
        const dir = SetFixture.Vendored('tampered')
        const file = join(dir, ReleaseApp.HiveAgent + '.json')
        const document = JSON.parse(readFileSync(file, SetFixture.Utf8)) as { version: string }
        document.version = SetFixture.Other
        writeFileSync(file, JSON.stringify(document))
        assert.throws(() => ComponentDescriptorSet.FromDirectory(dir), (e: Error) => e instanceof ComponentDescriptorSetDigestError && e.message.includes(ReleaseApp.HiveAgent))
    })

    it('answers undefined for a component it does not carry', () =>
    {
        assert.equal(ComponentDescriptorSet.FromDirectory(SetFixture.Vendored('unknown')).Get(SetFixture.Unknown), undefined)
    })
})

describe('ComponentDescriptorCli with a caller\'s source', () =>
{
    it('emits only the apps the source declares, and refuses a digest that is not the declared one', () =>
    {
        const out = join(SetFixture.Scratch, 'emit-all')
        const lines: string[] = []
        const output = { Out: (line: string) => lines.push(line), Err: (line: string) => lines.push(line) }
        assert.equal(ComponentDescriptorCli.Run(['emit-all', '--out', out], output, new TwoComponents()), 0)
        assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(out, ComponentDescriptorCli.DigestsFile), SetFixture.Utf8)) as object), [...TwoComponents.Apps])
        const digest = new TwoComponents().Of(ReleaseApp.HiveAgent).ContentDigest()
        assert.equal(ComponentDescriptorCli.Run(['emit', '--app', ReleaseApp.HiveAgent, '--digest', digest, '--out', join(out, 'one.json')], output, new TwoComponents()), 0)
        assert.equal(ComponentDescriptorCli.Run(['emit', '--app', ReleaseApp.HiveAgent, '--digest', 'sha256:' + '0'.repeat(64), '--out', join(out, 'two.json')], output, new TwoComponents()), 1)
    })
})
