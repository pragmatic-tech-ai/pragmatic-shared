import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** This package's own manifest. */
class Manifest
{
    public static readonly Path = join(import.meta.dirname, '..', '..', 'package.json')
    public static readonly Utf8 = 'utf8'
    /** The engine and UI packages a dependency-light consumer (the hive agent, the host agent) must never pull in. */
    public static readonly Forbidden: readonly string[] = ['@pragmatic-tech-ai/todl', '@pragmatic-tech-ai/todl-runtime', '@pragmatic-tech-ai/mural']
    public static readonly Sections: readonly string[] = ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']

    public static Read(): Record<string, Record<string, string> | undefined>
    {
        return JSON.parse(readFileSync(Manifest.Path, Manifest.Utf8)) as Record<string, Record<string, string> | undefined>
    }
}

describe('package dependencies', () =>
{
    it('declares no dependency on todl, todl-runtime or mural', () =>
    {
        const manifest = Manifest.Read()
        for (const section of Manifest.Sections)
        {
            for (const name of Manifest.Forbidden)
            {
                assert.equal(manifest[section]?.[name], undefined, `${section}/${name}`)
            }
        }
    })

    it('runs on node built-ins alone: no runtime or peer dependency', () =>
    {
        const manifest = Manifest.Read()
        assert.deepEqual(Object.keys(manifest.dependencies ?? {}), [])
        assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}), [])
    })
})
