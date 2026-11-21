import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { OciRegistryClient, type OciFetch } from '../../oci-registry-client.js'
import { FakeReleaseImage } from '../../tests/fake-release-image.js'
import { Channel } from '../../channel.js'
import { ReleaseDescriptorCodec } from '../release-descriptor.js'
import { ReleaseManifest, ReleaseManifestProblemKind } from '../release-manifest.js'
import { ReleasePublishCli } from '../release-publish-cli.js'
import { ReleaseManifestProblemsError, ReleasePublisher, ReleaseSigningKeyMismatchError, ReleaseVersionExistsError } from '../release-publisher.js'
import { ReleaseSignature } from '../release-signature.js'
import { ReleaseApp, ReleaseApps } from '../release-tag.js'
import { ReleaseTrustKeys } from '../release-trust-keys.js'
import { ReleaseWorld } from './release-manifest-fixture.js'

class Keys
{
    public readonly Private: string
    public readonly Public: string

    public constructor()
    {
        const pair = generateKeyPairSync('ed25519')
        this.Private = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
        this.Public = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    }
}

class AssembleFixture
{
    public static readonly KeyId = 'release-2026-11'
    public static readonly ReleaseCommit = 'c'.repeat(40)
    public static readonly BuiltAt = '2026-11-21T10:00:00.000Z'
    public static readonly MethodHead = 'HEAD'
    public static readonly MethodGet = 'GET'
    public static readonly MethodPut = 'PUT'
    public static readonly DescriptorRepo = ReleaseWorld.Namespace + '/' + ReleasePublisher.DescriptorRepository

    public readonly World: ReleaseWorld
    public readonly Key = new Keys()
    public Trusted: string

    public constructor(skip?: ReleaseApp)
    {
        this.World = new ReleaseWorld(skip)
        this.Trusted = this.Key.Public
    }

    public Publisher(): ReleasePublisher
    {
        return new ReleasePublisher(this.World.Client(), ReleaseWorld.Namespace, () => new Date(AssembleFixture.BuiltAt))
    }

    public Input()
    {
        return {
            Manifest: ReleaseManifest.Parse(this.World.ManifestText()),
            Assets: this.World.Assets,
            ReleaseCommit: AssembleFixture.ReleaseCommit,
            SigningKeyId: AssembleFixture.KeyId,
            PrivateKeyPem: this.Key.Private,
            TrustedPublicKeyPem: this.Trusted,
        }
    }

    public get PushedNothing(): boolean
    {
        return this.World.Registry.Requests.every(r => r.method === AssembleFixture.MethodHead || r.method === AssembleFixture.MethodGet)
    }
}

class ManifestCli
{
    public static readonly ManifestName = 'release.json'
    public static readonly KeyName = 'key.pem'
    public static readonly TrustName = 'release-keys'
    public static readonly Token = 'ghs_registry_token_value'
    public static readonly GitHubToken = 'ghs_github_token_value'

    public readonly Dir = mkdtempSync(join(tmpdir(), 'release-manifest-cli-'))
    public readonly Lines: string[] = []
    public readonly Errors: string[] = []
    public readonly Env: NodeJS.ProcessEnv

    public constructor(public readonly Base: AssembleFixture)
    {
        writeFileSync(this.Manifest, Base.World.ManifestText())
        writeFileSync(join(this.Dir, ManifestCli.KeyName), Base.Key.Private)
        mkdirSync(this.TrustDir)
        writeFileSync(join(this.TrustDir, AssembleFixture.KeyId + ReleaseTrustKeys.Suffix), Base.Trusted)
        this.Env = {
            RELEASE_SIGNING_KEY_FILE: join(this.Dir, ManifestCli.KeyName),
            RELEASE_REGISTRY_USER: 'release-bot',
            RELEASE_REGISTRY_TOKEN: ManifestCli.Token,
            RELEASE_REGISTRY: Base.World.Registry.Origin,
            RELEASE_NAMESPACE: ReleaseWorld.Namespace,
            GITHUB_TOKEN: ManifestCli.GitHubToken,
            GITHUB_SHA: AssembleFixture.ReleaseCommit,
        }
    }

    public get Manifest(): string
    {
        return join(this.Dir, ManifestCli.ManifestName)
    }

    public get TrustDir(): string
    {
        return join(this.Dir, ManifestCli.TrustName)
    }

    public PublishArgs(): string[]
    {
        return ['publish', '--manifest', this.Manifest, '--key-id', AssembleFixture.KeyId, '--trust-dir', this.TrustDir]
    }

    public Run(...argv: string[]): Promise<number>
    {
        const output = { Out: (line: string) => { this.Lines.push(line) }, Err: (line: string) => { this.Errors.push(line) } }
        return ReleasePublishCli.Run(argv, this.Env, output, this.Base.World.Registry.Fetch, this.Base.World.Assets)
    }

    public static async With(base: AssembleFixture, body: (cli: ManifestCli) => Promise<void>): Promise<void>
    {
        const cli = new ManifestCli(base)
        try
        {
            await body(cli)
        }
        finally
        {
            rmSync(cli.Dir, { recursive: true, force: true })
        }
    }
}

describe('ReleasePublisher from a release manifest', () =>
{
    it('Assemble checks only: no problems for an agreeing world, the problems otherwise, and never writes', async () =>
    {
        const clean = new AssembleFixture()
        const ok = await clean.Publisher().Assemble(ReleaseManifest.Parse(clean.World.ManifestText()), clean.World.Assets)
        assert.deepEqual(ok.Problems, [])
        assert.ok(clean.PushedNothing)

        const broken = new AssembleFixture(ReleaseApp.HiveAgent)
        const bad = await broken.Publisher().Assemble(ReleaseManifest.Parse(broken.World.ManifestText()), broken.World.Assets)
        assert.deepEqual(bad.Problems.map(p => p.App), [ReleaseApp.HiveAgent, ReleaseApp.HiveAgent, ReleaseApp.HiveAgent])
        assert.ok(broken.PushedNothing)
    })

    it('publishes a schema-2 descriptor of the manifest digests, the labelled component digests and each repository commit, signed', async () =>
    {
        const f = new AssembleFixture()
        const { descriptor, descriptorDigest } = await f.Publisher().PublishManifest(f.Input())
        assert.equal(descriptor.schema, 2)
        assert.equal(descriptor.version, ReleaseWorld.ReleaseVersion)
        assert.equal(descriptor.channel, Channel.EarlyAccess)
        assert.equal(descriptor.serverCommit, AssembleFixture.ReleaseCommit)
        assert.deepEqual(descriptor.siblingCommits, Object.fromEntries(ReleaseApps.All.map(app => [app, ReleaseWorld.CommitOf(app)])))
        assert.equal(descriptor.builtAt, AssembleFixture.BuiltAt)
        assert.equal(descriptor.signingKeyId, AssembleFixture.KeyId)
        for (const [app, image] of ReleaseDescriptorCodec.ImagesOf(descriptor))
        {
            assert.equal(image.repository, ReleaseWorld.ImageRepo(app))
            assert.equal(image.digest, f.World.Digests.get(app))
            assert.equal(image.componentDigest, f.World.ComponentDigests.get(app))
            assert.ok(ReleaseSignature.Verifies(image.digest, image.signature, f.Key.Public))
        }
        const pushed = await f.World.Client().PullManifest(AssembleFixture.DescriptorRepo, ReleaseWorld.ReleaseVersion)
        const manifest = JSON.parse(new TextDecoder().decode(pushed))
        assert.equal(manifest.layers[0].digest, descriptorDigest)
        assert.ok(ReleaseSignature.Verifies(descriptorDigest, manifest.annotations[ReleasePublisher.SignatureAnnotation], f.Key.Public))
    })

    it('tags every image release-<version> (the same digest), leaves the container tags alone, then pushes the descriptor last', async () =>
    {
        const f = new AssembleFixture()
        await f.Publisher().PublishManifest(f.Input())
        const client = f.World.Client()
        for (const app of ReleaseApps.All)
        {
            assert.equal(await client.HeadManifest(ReleaseWorld.ImageRepo(app), ReleaseManifest.ImageTagOf(ReleaseWorld.ReleaseVersion)), f.World.Digests.get(app), app)
            assert.equal(await client.HeadManifest(ReleaseWorld.ImageRepo(app), ReleaseWorld.ReleaseVersion), undefined, app)
            assert.equal(await client.HeadManifest(ReleaseWorld.ImageRepo(app), ReleaseWorld.ComponentVersion), f.World.Digests.get(app), app)
        }
        const puts = f.World.Registry.Requests.filter(r => r.method === AssembleFixture.MethodPut)
        assert.ok(puts.at(-1)?.url.includes(AssembleFixture.DescriptorRepo + '/manifests/' + ReleaseWorld.ReleaseVersion))
        const tagPuts = puts.filter(r => !r.url.includes(AssembleFixture.DescriptorRepo))
        assert.equal(tagPuts.length, ReleaseApps.All.length)
    })

    it('refuses a manifest Check finds problems with, naming them, and writes nothing', async () =>
    {
        const f = new AssembleFixture()
        f.World.Digests.set(ReleaseApp.TenantAdmin, f.World.PutImage(ReleaseApp.TenantAdmin, FakeReleaseImage.ComponentDigestOf('stale'), 'rebuilt'))
        await assert.rejects(f.Publisher().PublishManifest(f.Input()), (error: unknown) =>
            error instanceof ReleaseManifestProblemsError
            && error.Problems.length === 1
            && error.Problems[0].Kind === ReleaseManifestProblemKind.AssetMismatch
            && error.message.includes(ReleaseApp.TenantAdmin))
        assert.ok(f.PushedNothing)
    })

    it('refuses a published version and a signing key the trusted key does not verify, writing nothing', async () =>
    {
        const taken = new AssembleFixture()
        await taken.Publisher().PublishManifest(taken.Input())
        await assert.rejects(taken.Publisher().PublishManifest(taken.Input()), ReleaseVersionExistsError)

        const mismatched = new AssembleFixture()
        mismatched.Trusted = new Keys().Public
        await assert.rejects(mismatched.Publisher().PublishManifest(mismatched.Input()), ReleaseSigningKeyMismatchError)
        assert.ok(mismatched.PushedNothing)
    })

    it('finishes a publish that stopped after tagging some images: re-run as is', async () =>
    {
        const f = new AssembleFixture()
        const client = f.World.Client()
        const tag = ReleaseManifest.ImageTagOf(ReleaseWorld.ReleaseVersion)
        for (const app of [ReleaseApp.PlatformAdmin, ReleaseApp.EnvServer])
        {
            await client.TagManifest(ReleaseWorld.ImageRepo(app), f.World.Digests.get(app) as string, tag)
        }
        const { descriptor } = await f.Publisher().PublishManifest(f.Input())
        assert.equal(descriptor.version, ReleaseWorld.ReleaseVersion)
        for (const app of ReleaseApps.All)
        {
            assert.equal(await client.HeadManifest(ReleaseWorld.ImageRepo(app), tag), f.World.Digests.get(app), app)
        }
    })

    it('checks the version is free again just before the descriptor push: a publish that finished meanwhile wins', async () =>
    {
        const f = new AssembleFixture()
        const rival = new AssembleFixture()
        const descriptorPath = '/v2/' + AssembleFixture.DescriptorRepo + '/manifests/' + ReleaseWorld.ReleaseVersion
        let raced = false
        const fetch: OciFetch = async (url, init) =>
        {
            if (!raced && init.method === AssembleFixture.MethodPut && url.includes('/manifests/release-'))
            {
                raced = true
                const head = await rival.World.Client().HeadManifest(AssembleFixture.DescriptorRepo, ReleaseWorld.ReleaseVersion)
                assert.equal(head, undefined)
                f.World.Registry.PutManifest(AssembleFixture.DescriptorRepo, ReleaseWorld.ReleaseVersion, new TextEncoder().encode('{}'), 'application/vnd.oci.image.manifest.v1+json')
            }
            return f.World.Registry.Fetch(url, init)
        }
        const publisher = new ReleasePublisher(new OciRegistryClient(f.World.Registry.Origin, fetch), ReleaseWorld.Namespace)
        await assert.rejects(publisher.PublishManifest(f.Input()), ReleaseVersionExistsError)
        assert.ok(raced)
        assert.ok(!f.World.Registry.Requests.some(r => r.method === AssembleFixture.MethodPut && r.url.endsWith(descriptorPath)), 'the descriptor is not pushed over it')
    })

    it('refuses a release commit that is not 40 hex before any request', async () =>
    {
        const f = new AssembleFixture()
        await assert.rejects(f.Publisher().PublishManifest({ ...f.Input(), ReleaseCommit: 'main' }), /40-hex/)
        assert.equal(f.World.Registry.Requests.length, 0)
    })
})

describe('ReleasePublishCli with a release manifest', () =>
{
    it('assemble prints that the manifest assembles and exits 0', async () =>
    {
        await ManifestCli.With(new AssembleFixture(), async cli =>
        {
            assert.equal(await cli.Run('assemble', '--manifest', cli.Manifest), 0)
            assert.deepEqual(cli.Errors, [])
            assert.equal(cli.Lines.length, 1)
            assert.ok(cli.Lines[0].includes(ReleaseWorld.ReleaseVersion))
            assert.ok(cli.Base.PushedNothing)
        })
    })

    it('assemble refuses a version whose release descriptor is already published', async () =>
    {
        const f = new AssembleFixture()
        await f.Publisher().PublishManifest(f.Input())
        await ManifestCli.With(f, async cli =>
        {
            assert.equal(await cli.Run('assemble', '--manifest', cli.Manifest), 1)
            assert.deepEqual(cli.Errors, [new ReleaseVersionExistsError(ReleaseWorld.ReleaseVersion).message])
        })
    })

    it('assemble prints each problem as <app>: <sentence> and exits 1', async () =>
    {
        await ManifestCli.With(new AssembleFixture(ReleaseApp.UiUnpack), async cli =>
        {
            assert.equal(await cli.Run('assemble', '--manifest', cli.Manifest), 1)
            assert.deepEqual(cli.Errors, [
                ReleaseApp.UiUnpack + ': ' + ReleaseManifestProblemKind.ImageMissing,
                ReleaseApp.UiUnpack + ': ' + ReleaseManifestProblemKind.AssetMissing,
                ReleaseApp.UiUnpack + ': ' + ReleaseManifestProblemKind.CommitMissing,
            ])
        })
    })

    it('assemble refuses an invalid manifest with its sentence, and an unreadable one', async () =>
    {
        await ManifestCli.With(new AssembleFixture(), async cli =>
        {
            writeFileSync(cli.Manifest, JSON.stringify({ schema: 1 }))
            assert.equal(await cli.Run('assemble', '--manifest', cli.Manifest), 1)
            assert.match(cli.Errors[0], /^Invalid release manifest: /)
            assert.equal(await cli.Run('assemble', '--manifest', join(cli.Dir, 'nope.json')), 1)
            assert.equal(cli.Errors[1], 'The file named by --manifest cannot be read')
        })
    })

    it('publish --manifest publishes, prints version, images and descriptor digest, and no secret', async () =>
    {
        await ManifestCli.With(new AssembleFixture(), async cli =>
        {
            assert.equal(await cli.Run(...cli.PublishArgs()), 0, cli.Errors.join('\n'))
            assert.equal(cli.Lines.length, ReleaseApps.All.length + 2)
            assert.equal(cli.Lines[0], 'published ' + ReleaseWorld.ReleaseVersion)
            const stdout = cli.Lines.join('\n')
            for (const secret of [ManifestCli.Token, ManifestCli.GitHubToken, cli.Base.Key.Private.split('\n')[1]])
            {
                assert.ok(!stdout.includes(secret))
            }
            const descriptor = ReleaseDescriptorCodec.Decode(await ManifestCliProbe.Layer(cli))
            assert.equal(descriptor.serverCommit, AssembleFixture.ReleaseCommit, 'the release commit defaults to GITHUB_SHA')
        })
    })

    it('publish --manifest takes --release-commit over GITHUB_SHA and refuses neither', async () =>
    {
        const other = 'd'.repeat(40)
        await ManifestCli.With(new AssembleFixture(), async cli =>
        {
            assert.equal(await cli.Run(...cli.PublishArgs(), '--release-commit', other), 0, cli.Errors.join('\n'))
            assert.equal(ReleaseDescriptorCodec.Decode(await ManifestCliProbe.Layer(cli)).serverCommit, other)
        })
        await ManifestCli.With(new AssembleFixture(), async cli =>
        {
            delete cli.Env.GITHUB_SHA
            assert.equal(await cli.Run(...cli.PublishArgs()), 1)
            assert.deepEqual(cli.Errors, ['Missing required option: --release-commit (or GITHUB_SHA)'])
            assert.ok(cli.Base.PushedNothing)
        })
    })

    it('publish refuses mixing --manifest with the tag options, and assemble refuses publish options', async () =>
    {
        await ManifestCli.With(new AssembleFixture(), async cli =>
        {
            assert.equal(await cli.Run(...cli.PublishArgs(), '--tag', 'release/0.1.0-early.6'), 1)
            assert.match(cli.Errors[0], /--manifest/)
            assert.equal(await cli.Run('assemble', '--manifest', cli.Manifest, '--key-id', AssembleFixture.KeyId), 1)
            assert.equal(cli.Errors[1], 'Unknown option: --key-id')
            assert.equal(cli.Base.World.Registry.Requests.length, 0)
        })
    })
})

class ManifestCliProbe
{
    /** The descriptor bytes the CLI pushed (the artifact's one layer). */
    public static async Layer(cli: ManifestCli): Promise<Uint8Array>
    {
        const client = new OciRegistryClient(cli.Base.World.Registry.Origin, cli.Base.World.Registry.Fetch)
        const manifest = JSON.parse(new TextDecoder().decode(await client.PullManifest(AssembleFixture.DescriptorRepo, ReleaseWorld.ReleaseVersion)))
        return client.PullBlob(AssembleFixture.DescriptorRepo, manifest.layers[0].digest)
    }
}
