import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ComponentAssetUnavailableError, GitHubComponentAssetSource, type GitHubFetch, type GitHubRequestInit } from '../component-asset-source.js'

type Seen = { Url: string; Init: GitHubRequestInit }

/** A GitHub REST API (and its asset download host) behind the GitHubFetch seam, answering from a route table. */
class FakeGitHub
{
    public static readonly Api = 'https://api.github.test'
    public static readonly Download = 'https://objects.github.test/asset/42?sig=abc'
    public static readonly Repository = 'pragmatic-tech-ai/pragmatic-ui-unpack'
    public static readonly Version = '0.1.0'
    public static readonly Token = 'ghs_secret_token_value'
    public static readonly Commit = '0123456789abcdef0123456789abcdef01234567'
    public static readonly AssetApiUrl = FakeGitHub.Api + '/repos/pragmatic-tech-ai/pragmatic-ui-unpack/releases/assets/42'
    public static readonly ReleaseUrl = FakeGitHub.Api + '/repos/pragmatic-tech-ai/pragmatic-ui-unpack/releases/tags/v0.1.0'
    public static readonly CommitUrl = FakeGitHub.Api + '/repos/pragmatic-tech-ai/pragmatic-ui-unpack/commits/v0.1.0'
    public static readonly AssetBytes = new TextEncoder().encode('{"component":"pragmatic-ui-unpack","version":"0.1.0"}')
    public static readonly Authorization = 'Authorization'

    public readonly Seen: Seen[] = []
    public readonly Routes = new Map<string, () => Response>()

    public constructor()
    {
        this.Routes.set(FakeGitHub.ReleaseUrl, () => FakeGitHub.Json({ assets: [{ name: 'digest.txt', url: FakeGitHub.Api + '/x' }, { name: 'component.json', url: FakeGitHub.AssetApiUrl }] }))
        this.Routes.set(FakeGitHub.AssetApiUrl, () => new Response(null, { status: 302, headers: { location: FakeGitHub.Download } }))
        this.Routes.set(FakeGitHub.Download, () => new Response(FakeGitHub.AssetBytes as BodyInit, { status: 200 }))
        this.Routes.set(FakeGitHub.CommitUrl, () => new Response(FakeGitHub.Commit + '\n', { status: 200 }))
    }

    public static Json(value: unknown, status: number = 200): Response
    {
        return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    }

    public get Fetch(): GitHubFetch
    {
        return async (url, init) =>
        {
            this.Seen.push({ Url: url, Init: init })
            const route = this.Routes.get(url)
            return route === undefined ? new Response(null, { status: 404 }) : route()
        }
    }

    public Source(token?: string): GitHubComponentAssetSource
    {
        return new GitHubComponentAssetSource(this.Fetch, token, FakeGitHub.Api)
    }
}

describe('GitHubComponentAssetSource', () =>
{
    it('reads the component.json asset of release v<version>, following the download redirect without the token', async () =>
    {
        const github = new FakeGitHub()
        const bytes = await github.Source(FakeGitHub.Token).ComponentAsset(FakeGitHub.Repository, FakeGitHub.Version)
        assert.deepEqual(bytes, FakeGitHub.AssetBytes)
        assert.deepEqual(github.Seen.map(s => s.Url), [FakeGitHub.ReleaseUrl, FakeGitHub.AssetApiUrl, FakeGitHub.Download])
        assert.equal(github.Seen[0].Init.headers[FakeGitHub.Authorization], 'Bearer ' + FakeGitHub.Token)
        assert.equal(github.Seen[1].Init.headers[FakeGitHub.Authorization], 'Bearer ' + FakeGitHub.Token)
        assert.equal(github.Seen[1].Init.headers.Accept, 'application/octet-stream')
        assert.equal(github.Seen[2].Init.headers[FakeGitHub.Authorization], undefined, 'the download host never gets the token')
        assert.ok(github.Seen.every(s => s.Init.redirect === 'manual' && s.Init.method === 'GET'))
    })

    it('sends no token when none is given', async () =>
    {
        const github = new FakeGitHub()
        await github.Source().ComponentAsset(FakeGitHub.Repository, FakeGitHub.Version)
        assert.ok(github.Seen.every(s => s.Init.headers[FakeGitHub.Authorization] === undefined))
    })

    it('answers undefined for a release that does not exist or has no component.json', async () =>
    {
        const github = new FakeGitHub()
        assert.equal(await github.Source().ComponentAsset(FakeGitHub.Repository, '9.9.9'), undefined)
        github.Routes.set(FakeGitHub.ReleaseUrl, () => FakeGitHub.Json({ assets: [{ name: 'digest.txt', url: FakeGitHub.Api + '/x' }] }))
        assert.equal(await github.Source().ComponentAsset(FakeGitHub.Repository, FakeGitHub.Version), undefined)
    })

    it('reads a directly served asset (no redirect)', async () =>
    {
        const github = new FakeGitHub()
        github.Routes.set(FakeGitHub.AssetApiUrl, () => new Response(FakeGitHub.AssetBytes as BodyInit, { status: 200 }))
        assert.deepEqual(await github.Source().ComponentAsset(FakeGitHub.Repository, FakeGitHub.Version), FakeGitHub.AssetBytes)
    })

    it('refuses an asset URL off the API origin, a non-https redirect, a redirect without a location and an oversized asset', async () =>
    {
        const cases: Array<[string, () => Response]> = [
            [FakeGitHub.ReleaseUrl, () => FakeGitHub.Json({ assets: [{ name: 'component.json', url: 'https://elsewhere.test/a' }] })],
            [FakeGitHub.AssetApiUrl, () => new Response(null, { status: 302, headers: { location: 'http://objects.github.test/a' } })],
            [FakeGitHub.AssetApiUrl, () => new Response(null, { status: 302 })],
            [FakeGitHub.Download, () => new Response(new Uint8Array(GitHubComponentAssetSource.MaxAssetBytes + 1) as BodyInit, { status: 200 })],
            [FakeGitHub.ReleaseUrl, () => FakeGitHub.Json({ assets: 'none' })],
            [FakeGitHub.ReleaseUrl, () => FakeGitHub.Json({ assets: [{ name: 'component.json', url: 7 }] })],
            [FakeGitHub.ReleaseUrl, () => new Response('not json', { status: 200 })],
            [FakeGitHub.ReleaseUrl, () => new Response(null, { status: 500 })],
        ]
        for (const [url, route] of cases)
        {
            const github = new FakeGitHub()
            github.Routes.set(url, route)
            await assert.rejects(github.Source(FakeGitHub.Token).ComponentAsset(FakeGitHub.Repository, FakeGitHub.Version), (error: unknown) =>
                error instanceof ComponentAssetUnavailableError && !error.message.includes(FakeGitHub.Token), url)
        }
    })

    it('reads the commit tag v<version> names, undefined for a tag GitHub does not know', async () =>
    {
        const github = new FakeGitHub()
        const source = github.Source(FakeGitHub.Token)
        assert.equal(await source.ReleaseCommit(FakeGitHub.Repository, FakeGitHub.Version), FakeGitHub.Commit)
        assert.equal(github.Seen[0].Init.headers.Accept, 'application/vnd.github.sha')
        assert.equal(await source.ReleaseCommit(FakeGitHub.Repository, '9.9.9'), undefined)
        github.Routes.set(FakeGitHub.CommitUrl, () => new Response(null, { status: 422 }))
        assert.equal(await source.ReleaseCommit(FakeGitHub.Repository, FakeGitHub.Version), undefined)
        github.Routes.set(FakeGitHub.CommitUrl, () => new Response('main', { status: 200 }))
        await assert.rejects(source.ReleaseCommit(FakeGitHub.Repository, FakeGitHub.Version), ComponentAssetUnavailableError)
    })

    it('refuses a repository that is not <owner>/<name> before any request, and a fetch that throws as unreachable', async () =>
    {
        const github = new FakeGitHub()
        for (const repository of ['pragmatic-ui-unpack', 'a/b/c', '../x/y', 'a/b?c'])
        {
            await assert.rejects(github.Source().ComponentAsset(repository, FakeGitHub.Version), ComponentAssetUnavailableError, repository)
            await assert.rejects(github.Source().ReleaseCommit(repository, FakeGitHub.Version), ComponentAssetUnavailableError, repository)
        }
        assert.deepEqual(github.Seen, [])
        const down = new GitHubComponentAssetSource(async () => { throw new Error('connect ECONNREFUSED ' + FakeGitHub.Token) }, FakeGitHub.Token, FakeGitHub.Api)
        await assert.rejects(down.ComponentAsset(FakeGitHub.Repository, FakeGitHub.Version), (error: unknown) =>
            error instanceof ComponentAssetUnavailableError && !error.message.includes(FakeGitHub.Token))
    })
})
