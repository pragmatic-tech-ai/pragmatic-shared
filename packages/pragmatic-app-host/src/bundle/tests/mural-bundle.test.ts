import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MuralBundle } from '../mural-bundle.js'
import { TestHttp } from '../../tests/support/test-http.js'

class BundleFixture
{
    public static Root = ''
    public static Http: TestHttp

    public static async Create(): Promise<void>
    {
        BundleFixture.Root = await mkdtemp(join(tmpdir(), 'mural-bundle-'))
        await mkdir(join(BundleFixture.Root, 'assets', 'fonts'), { recursive: true })
        await writeFile(join(BundleFixture.Root, 'index.html'), '<!doctype html><title>App</title>')
        await writeFile(join(BundleFixture.Root, 'assets', 'index-BdsCYF7S.js'), 'console.log(1)')
        await writeFile(join(BundleFixture.Root, 'assets', 'app.mu-SGTqTQDc.css'), 'body{}')
        await writeFile(join(BundleFixture.Root, 'assets', 'fonts', 'InterTight-Medium.woff2'), 'font')
        await writeFile(join(BundleFixture.Root, 'favicon.svg'), '<svg/>')
        await writeFile(join(tmpdir(), 'outside-secret.txt'), 'secret')
        const bundle = MuralBundle.Load(BundleFixture.Root)
        BundleFixture.Http = await TestHttp.Start((req, res) => bundle.Serve(req, res, new URL(req.url ?? '/', 'http://x').pathname))
    }
}

before(async () => await BundleFixture.Create())
after(async () =>
{
    await BundleFixture.Http.Close()
    await rm(BundleFixture.Root, { recursive: true, force: true })
})

test('the index is served at / with no-cache', async () =>
{
    const answer = await BundleFixture.Http.Send('/')
    assert.equal(answer.Status, 200)
    assert.equal(answer.Body, '<!doctype html><title>App</title>')
    assert.equal(answer.Header('content-type'), 'text/html; charset=utf-8')
    assert.equal(answer.Header('cache-control'), 'no-cache')
})

test('a content-hashed asset is immutable; other files revalidate hourly; types follow the extension', async () =>
{
    const script = await BundleFixture.Http.Send('/assets/index-BdsCYF7S.js')
    assert.equal(script.Status, 200)
    assert.equal(script.Header('content-type'), 'text/javascript; charset=utf-8')
    assert.equal(script.Header('cache-control'), 'public, max-age=31536000, immutable')
    assert.equal((await BundleFixture.Http.Send('/assets/app.mu-SGTqTQDc.css')).Header('cache-control'), 'public, max-age=31536000, immutable')
    const font = await BundleFixture.Http.Send('/assets/fonts/InterTight-Medium.woff2')
    assert.equal(font.Header('content-type'), 'font/woff2')
    assert.equal(font.Header('cache-control'), 'public, max-age=3600')
    assert.equal((await BundleFixture.Http.Send('/favicon.svg')).Header('content-type'), 'image/svg+xml')
})

test('a client route (no extension) falls back to the index; a missing file is 404', async () =>
{
    const spa = await BundleFixture.Http.Send('/hives/h1/settings')
    assert.equal(spa.Status, 200)
    assert.equal(spa.Header('cache-control'), 'no-cache')
    assert.match(spa.Body, /<title>App<\/title>/)
    assert.equal((await BundleFixture.Http.Send('/assets/missing-ABCDEFGH.js')).Status, 404)
})

test('traversal, encoded traversal, backslashes and malformed escapes never leave the root', async () =>
{
    for (const path of ['/../outside-secret.txt', '/%2e%2e/outside-secret.txt', '/assets/..%2f..%2foutside-secret.txt', '/..%5coutside-secret.txt', '/%E0.txt'])
    {
        const answer = await BundleFixture.Http.Send(path)
        assert.ok(!answer.Body.includes('secret'), path)
        assert.equal(answer.Status, 404, path)
    }
})

test('HEAD answers the headers without a body; other methods are not served', async () =>
{
    const head = await BundleFixture.Http.Send('/assets/index-BdsCYF7S.js', { Method: 'HEAD' })
    assert.equal(head.Status, 200)
    assert.equal(head.Body, '')
    assert.equal(head.Header('content-length'), String('console.log(1)'.length))
    assert.equal((await BundleFixture.Http.Send('/', { Method: 'POST' })).Status, 405)
})

test('Load refuses a root without an index', async () =>
{
    const empty = await mkdtemp(join(tmpdir(), 'mural-empty-'))
    assert.throws(() => MuralBundle.Load(empty), /index\.html/)
    await rm(empty, { recursive: true, force: true })
})
