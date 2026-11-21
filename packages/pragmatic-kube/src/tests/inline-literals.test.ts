import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Source scans for the no-inline-literal rule where reviews found breaches. */
class KubeSources
{
    public static readonly Root = join(import.meta.dirname, '..')
    public static readonly Utf8 = 'utf8'
    public static readonly InlineSlashJoin = "+ '/' +"

    public static Text(file: string): string
    {
        return readFileSync(join(KubeSources.Root, file), KubeSources.Utf8)
    }
}

describe('kube inline literals', () =>
{
    it('ApiKubectl joins resource names with its Slash constant', () =>
    {
        assert.ok(!KubeSources.Text('api-kubectl.ts').includes(KubeSources.InlineSlashJoin))
    })
})
