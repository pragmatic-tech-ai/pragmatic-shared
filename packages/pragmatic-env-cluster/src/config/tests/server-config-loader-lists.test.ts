import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServerConfigLoader } from '../server-config-loader.js'

class ListEnv
{
    public static Base(allowlist: string): Record<string, string | undefined>
    {
        return { PRAGMATIC_BASE_DIR: '/data', PRAGMATIC_MASTER_KEY_B64_ENV: 'PRAGMATIC_MASTER_KEY', PRAGMATIC_ENVIRONMENT_ID: 'acme', PRAGMATIC_ADAPTER_PACKS_SCRIPT_ALLOWLIST: allowlist }
    }

    public static NoFile(_p: string): string
    {
        throw new Error('no file')
    }
}

test('the script allowlist reads the JSON array text the start step writes, an item with a comma included', () =>
{
    const config = ServerConfigLoader.Load(ListEnv.Base('["a","b,c"]'), ListEnv.NoFile)
    assert.deepEqual(config.adapterPacks?.scriptAllowlist, ['a', 'b,c'])
})

test('the script allowlist keeps the hand-written comma form and refuses bad array text', () =>
{
    assert.deepEqual(ServerConfigLoader.Load(ListEnv.Base(' a, b ,,'), ListEnv.NoFile).adapterPacks?.scriptAllowlist, ['a', 'b'])
    assert.throws(() => ServerConfigLoader.Load(ListEnv.Base('[1]'), ListEnv.NoFile), /SCRIPT_ALLOWLIST/)
})
