import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { OciRegistryClient, type OciFetch } from '../oci-registry-client.js'
import { GitHubComponentAssetSource, type IComponentAssetSource } from './component-asset-source.js'
import { ReleaseDescriptorCodec, type ReleaseDescriptor } from './release-descriptor.js'
import { ReleaseManifest } from './release-manifest.js'
import { ReleasePublisher } from './release-publisher.js'
import { ReleaseRegistry } from './release-registry.js'
import { ReleaseTag } from './release-tag.js'
import { ReleaseTrustKeyInvalidError, ReleaseTrustKeys } from './release-trust-keys.js'

export type ReleaseCliOutput = { Out: (line: string) => void; Err: (line: string) => void }

class ReleaseCliUsageError extends Error
{
}

/**
 * `check --tag <ref>`, `publish --tag <ref> --server-commit <sha> --siblings-file <path> --key-id <id> [--trust-dir <dir>]`
 * (the images tagged with the release version), and from a release manifest (pragmatic-platform-release's `release.json`):
 * `assemble --manifest <path>` (checks only: prints each problem, exit 1 on any) and `publish --manifest <path> --key-id <id>
 * [--trust-dir <dir>] [--release-commit <sha>]` (the release commit defaults to GITHUB_SHA). Secrets come from the
 * environment (key file path, registry credential, the optional GITHUB_TOKEN the component assets are read with); only
 * the version and digests are printed, failures print the error sentence. Before anything is pushed, publish verifies
 * every signature against the trusted public key `<trust dir>/<key id>.pub.pem` (default: `release-keys` under the
 * working directory). Imports only node builtins and builtin-only relative modules: the release workflow runs it without
 * npm install.
 */
export class ReleasePublishCli
{
    private static readonly CommandCheck = 'check'
    private static readonly CommandPublish = 'publish'
    private static readonly CommandAssemble = 'assemble'
    private static readonly FlagPrefix = '--'
    private static readonly FlagTag = 'tag'
    private static readonly FlagServerCommit = 'server-commit'
    private static readonly FlagSiblingsFile = 'siblings-file'
    private static readonly FlagKeyId = 'key-id'
    private static readonly FlagTrustDir = 'trust-dir'
    private static readonly FlagManifest = 'manifest'
    private static readonly FlagReleaseCommit = 'release-commit'
    /** The tag-mode options a `publish --manifest` refuses (the manifest names the version, the commits come from GitHub). */
    private static readonly TagModeFlags: readonly string[] = [ReleasePublishCli.FlagTag, ReleasePublishCli.FlagServerCommit, ReleasePublishCli.FlagSiblingsFile]
    /** The options each command accepts: `check` refuses the publish-only ones. */
    private static readonly CommandFlags: ReadonlyMap<string, readonly string[]> = new Map([
        [ReleasePublishCli.CommandCheck, [ReleasePublishCli.FlagTag]],
        [ReleasePublishCli.CommandPublish, [
            ReleasePublishCli.FlagTag,
            ReleasePublishCli.FlagServerCommit,
            ReleasePublishCli.FlagSiblingsFile,
            ReleasePublishCli.FlagKeyId,
            ReleasePublishCli.FlagTrustDir,
            ReleasePublishCli.FlagManifest,
            ReleasePublishCli.FlagReleaseCommit,
        ]],
        [ReleasePublishCli.CommandAssemble, [ReleasePublishCli.FlagManifest]],
    ])
    private static readonly ManifestModeMessage = '--manifest replaces --tag, --server-commit and --siblings-file'
    private static readonly TagModeMessage = '--release-commit is for publish --manifest; with --tag give --server-commit'
    private static readonly UnreadableManifestMessage = 'The file named by --manifest cannot be read'
    private static readonly MissingReleaseCommitMessage = 'Missing required option: --release-commit (or GITHUB_SHA)'
    private static readonly EnvGitHubSha = 'GITHUB_SHA'
    private static readonly EnvGitHubToken = 'GITHUB_TOKEN'
    private static readonly EnvGitHubApi = 'GITHUB_API_URL'
    private static readonly ReleaseLabel = 'release '
    private static readonly AssemblesInfix = ' assembles: '
    private static readonly AppsCheckedSuffix = ' apps checked, no problems'
    private static readonly UnreadableTrustDirMessage = 'The directory named by --trust-dir (default: release-keys) cannot be read'
    private static readonly UntrustedKeyPrefix = 'No trusted public key for --key-id in the trust directory: expected '
    private static readonly UnknownFlagPrefix = 'Unknown option: --'
    private static readonly DuplicateFlagPrefix = 'Option given more than once: --'
    private static readonly UnreadableKeyMessage = 'The signing key file named by RELEASE_SIGNING_KEY_FILE cannot be read'
    private static readonly UnreadableSiblingsMessage = 'The file named by --siblings-file cannot be read'
    private static readonly EnvKeyFile = 'RELEASE_SIGNING_KEY_FILE'
    private static readonly EnvUser = 'RELEASE_REGISTRY_USER'
    private static readonly EnvToken = 'RELEASE_REGISTRY_TOKEN'
    private static readonly EnvRegistry = 'RELEASE_REGISTRY'
    private static readonly EnvNamespace = 'RELEASE_NAMESPACE'
    private static readonly DefaultNamespace = ReleaseRegistry.DefaultNamespace
    private static readonly SchemeMarker = '://'
    private static readonly HttpsScheme = ReleaseRegistry.HttpsScheme
    private static readonly Utf8 = 'utf8'
    private static readonly OkExitCode = 0
    private static readonly FailExitCode = 1
    private static readonly UsageMessage = 'Usage: pragmatic-release-publish check --tag <ref> | publish --tag <ref> --server-commit <sha> --siblings-file <path> --key-id <id> [--trust-dir <dir>] | assemble --manifest <path> | publish --manifest <path> --key-id <id> [--trust-dir <dir>] [--release-commit <sha>]'
    private static readonly MissingFlagPrefix = 'Missing required option: --'
    private static readonly MissingEnvPrefix = 'Missing required environment variable: '
    private static readonly BadSiblingsMessage = 'The siblings file must be a JSON object mapping plain repository names to 40-hex commit shas'
    private static readonly VersionLabel = 'version '
    private static readonly FreeSuffix = ' is free'
    private static readonly PublishedPrefix = 'published '
    private static readonly DescriptorLabel = 'descriptor '
    private static readonly ImageSeparator = ' '
    private static readonly ComponentLabel = ' component '

    /** The caller's release-keys: `release-keys` under the working directory the CLI runs in. */
    public static DefaultTrustDir(): string
    {
        return resolve(process.cwd(), ReleaseTrustKeys.DirName)
    }

    /** `assets` replaces the GitHub source of the component assets and release commits (tests). */
    public static async Run(argv: readonly string[], env: NodeJS.ProcessEnv, output: ReleaseCliOutput, fetchFn?: OciFetch, assets?: IComponentAssetSource): Promise<number>
    {
        const S = ReleasePublishCli
        try
        {
            const command = argv[0]
            const allowed = command === undefined ? undefined : S.CommandFlags.get(command)
            if (allowed === undefined)
            {
                throw new ReleaseCliUsageError(S.UsageMessage)
            }
            const flags = S.ParseFlags(argv.slice(1), allowed)
            if (command === S.CommandCheck)
            {
                await S.Check(flags, env, output, fetchFn)
            }
            else if (command === S.CommandAssemble)
            {
                return await S.Assemble(flags, env, output, fetchFn, assets)
            }
            else if (command === S.CommandPublish && flags.has(S.FlagManifest))
            {
                await S.PublishManifest(flags, env, output, fetchFn, assets)
            }
            else if (command === S.CommandPublish)
            {
                await S.Publish(flags, env, output, fetchFn)
            }
            else
            {
                throw new ReleaseCliUsageError(S.UsageMessage)
            }
            return S.OkExitCode
        }
        catch (err)
        {
            output.Err(err instanceof Error ? err.message : String(err))
            return S.FailExitCode
        }
    }

    private static async Check(flags: Map<string, string>, env: NodeJS.ProcessEnv, output: ReleaseCliOutput, fetchFn?: OciFetch): Promise<void>
    {
        const S = ReleasePublishCli
        const tag = ReleaseTag.Parse(S.Flag(flags, S.FlagTag))
        await S.NewPublisher(env, fetchFn).CheckVersionFree(tag.Version)
        output.Out(S.VersionLabel + tag.Version + S.FreeSuffix)
    }

    /** Refuses a published version; prints the problems (stderr) and answers 1, or one line and 0. */
    private static async Assemble(flags: Map<string, string>, env: NodeJS.ProcessEnv, output: ReleaseCliOutput, fetchFn?: OciFetch, assets?: IComponentAssetSource): Promise<number>
    {
        const S = ReleasePublishCli
        const manifest = ReleaseManifest.Parse(S.ReadFile(S.Flag(flags, S.FlagManifest), S.UnreadableManifestMessage))
        const publisher = S.NewPublisher(env, fetchFn)
        await publisher.CheckVersionFree(manifest.version)
        const inspection = await publisher.Assemble(manifest, assets ?? S.NewAssets(env))
        if (inspection.Problems.length > 0)
        {
            for (const problem of inspection.Problems)
            {
                output.Err(ReleaseManifest.Describe(problem))
            }
            return S.FailExitCode
        }
        output.Out(S.ReleaseLabel + manifest.version + S.AssemblesInfix + Object.keys(manifest.components).length + S.AppsCheckedSuffix)
        return S.OkExitCode
    }

    private static async PublishManifest(flags: Map<string, string>, env: NodeJS.ProcessEnv, output: ReleaseCliOutput, fetchFn?: OciFetch, assets?: IComponentAssetSource): Promise<void>
    {
        const S = ReleasePublishCli
        if (S.TagModeFlags.some(flag => flags.has(flag)))
        {
            throw new ReleaseCliUsageError(S.ManifestModeMessage)
        }
        const manifest = ReleaseManifest.Parse(S.ReadFile(S.Flag(flags, S.FlagManifest), S.UnreadableManifestMessage))
        const releaseCommit = flags.get(S.FlagReleaseCommit) ?? S.EnvOr(env, S.EnvGitHubSha, '')
        if (releaseCommit.length === 0)
        {
            throw new ReleaseCliUsageError(S.MissingReleaseCommitMessage)
        }
        const signingKeyId = S.Flag(flags, S.FlagKeyId)
        const trustedPublicKeyPem = S.TrustedKey(flags.get(S.FlagTrustDir) ?? S.DefaultTrustDir(), signingKeyId)
        const privateKeyPem = S.ReadFile(S.Env(env, S.EnvKeyFile), S.UnreadableKeyMessage)
        const input = { manifest, assets: assets ?? S.NewAssets(env), releaseCommit, signingKeyId, privateKeyPem, trustedPublicKeyPem }
        const result = await S.NewPublisher(env, fetchFn).PublishManifest(input)
        S.PrintPublished(result.descriptor, result.descriptorDigest, output)
    }

    private static async Publish(flags: Map<string, string>, env: NodeJS.ProcessEnv, output: ReleaseCliOutput, fetchFn?: OciFetch): Promise<void>
    {
        const S = ReleasePublishCli
        if (flags.has(S.FlagReleaseCommit))
        {
            throw new ReleaseCliUsageError(S.TagModeMessage)
        }
        const tag = ReleaseTag.Parse(S.Flag(flags, S.FlagTag))
        const serverCommit = S.Flag(flags, S.FlagServerCommit)
        const siblingCommits = S.ReadSiblings(S.Flag(flags, S.FlagSiblingsFile))
        const signingKeyId = S.Flag(flags, S.FlagKeyId)
        const trustedPublicKeyPem = S.TrustedKey(flags.get(S.FlagTrustDir) ?? S.DefaultTrustDir(), signingKeyId)
        const privateKeyPem = S.ReadFile(S.Env(env, S.EnvKeyFile), S.UnreadableKeyMessage)
        const input = { tag, serverCommit, siblingCommits, signingKeyId, privateKeyPem, trustedPublicKeyPem }
        const { descriptor, descriptorDigest } = await S.NewPublisher(env, fetchFn).Publish(input)
        S.PrintPublished(descriptor, descriptorDigest, output)
    }

    /** The version, each image digest (with its component digest) and the descriptor digest; never key material. */
    private static PrintPublished(descriptor: ReleaseDescriptor, descriptorDigest: string, output: ReleaseCliOutput): void
    {
        const S = ReleasePublishCli
        output.Out(S.PublishedPrefix + descriptor.version)
        for (const [app, image] of Object.entries(descriptor.images))
        {
            output.Out(image.componentDigest === undefined
                ? app + S.ImageSeparator + image.digest
                : app + S.ImageSeparator + image.digest + S.ComponentLabel + image.componentDigest)
        }
        output.Out(S.DescriptorLabel + descriptorDigest)
    }

    private static NewPublisher(env: NodeJS.ProcessEnv, fetchFn?: OciFetch): ReleasePublisher
    {
        const S = ReleasePublishCli
        const host = S.EnvOr(env, S.EnvRegistry, ReleaseRegistry.DefaultHost)
        const baseUrl = host.includes(S.SchemeMarker) ? host : S.HttpsScheme + host
        const credential = { username: S.Env(env, S.EnvUser), token: S.Env(env, S.EnvToken) }
        const registry = new OciRegistryClient(baseUrl, fetchFn, credential)
        return new ReleasePublisher(registry, S.EnvOr(env, S.EnvNamespace, S.DefaultNamespace))
    }

    /** The component assets and release commits from the GitHub API (GITHUB_API_URL, default api.github.com), with GITHUB_TOKEN when set. */
    private static NewAssets(env: NodeJS.ProcessEnv): IComponentAssetSource
    {
        const S = ReleasePublishCli
        const token = S.EnvOr(env, S.EnvGitHubToken, '')
        return new GitHubComponentAssetSource(undefined, token.length === 0 ? undefined : token, S.EnvOr(env, S.EnvGitHubApi, GitHubComponentAssetSource.DefaultApi))
    }

    private static ReadSiblings(path: string): Record<string, string>
    {
        const S = ReleasePublishCli
        let parsed: unknown
        try
        {
            parsed = JSON.parse(S.ReadFile(path, S.UnreadableSiblingsMessage))
        }
        catch (err)
        {
            throw err instanceof ReleaseCliUsageError ? err : new ReleaseCliUsageError(S.BadSiblingsMessage)
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        {
            throw new ReleaseCliUsageError(S.BadSiblingsMessage)
        }
        for (const [name, commit] of Object.entries(parsed))
        {
            if (!ReleaseDescriptorCodec.IsRepoName(name) || !ReleaseDescriptorCodec.IsCommit(commit))
            {
                throw new ReleaseCliUsageError(S.BadSiblingsMessage)
            }
        }
        return parsed as Record<string, string>
    }

    /** The trusted public key `<dir>/<key id>.pub.pem`; an unreadable directory or an absent key is a clear sentence. */
    private static TrustedKey(dir: string, keyId: string): string
    {
        const S = ReleasePublishCli
        let trust: ReleaseTrustKeys
        try
        {
            trust = ReleaseTrustKeys.FromDirectory(dir)
        }
        catch (err)
        {
            if (err instanceof ReleaseTrustKeyInvalidError)
            {
                throw err
            }
            throw new ReleaseCliUsageError(S.UnreadableTrustDirMessage)
        }
        const key = trust.KeyFor(keyId)
        if (key === undefined)
        {
            throw new ReleaseCliUsageError(S.UntrustedKeyPrefix + keyId + ReleaseTrustKeys.Suffix)
        }
        return key
    }

    /** Reads a file; an unreadable one becomes the given sentence (never the raw OS error). */
    private static ReadFile(path: string, unreadableMessage: string): string
    {
        try
        {
            return readFileSync(path, ReleasePublishCli.Utf8)
        }
        catch
        {
            throw new ReleaseCliUsageError(unreadableMessage)
        }
    }

    private static EnvOr(env: NodeJS.ProcessEnv, name: string, fallback: string): string
    {
        const value = env[name]
        return value === undefined || value.length === 0 ? fallback : value
    }

    private static ParseFlags(args: readonly string[], allowed: readonly string[]): Map<string, string>
    {
        const S = ReleasePublishCli
        const flags = new Map<string, string>()
        for (let i = 0; i < args.length; i++)
        {
            const arg = args[i]
            if (!arg.startsWith(S.FlagPrefix) || i + 1 >= args.length)
            {
                throw new ReleaseCliUsageError(S.UsageMessage)
            }
            const name = arg.slice(S.FlagPrefix.length)
            if (!allowed.includes(name))
            {
                throw new ReleaseCliUsageError(S.UnknownFlagPrefix + name)
            }
            if (flags.has(name))
            {
                throw new ReleaseCliUsageError(S.DuplicateFlagPrefix + name)
            }
            flags.set(name, args[++i])
        }
        return flags
    }

    private static Flag(flags: Map<string, string>, name: string): string
    {
        const value = flags.get(name)
        if (value === undefined || value.length === 0)
        {
            throw new ReleaseCliUsageError(ReleasePublishCli.MissingFlagPrefix + name)
        }
        return value
    }

    private static Env(env: NodeJS.ProcessEnv, name: string): string
    {
        const value = env[name]
        if (value === undefined || value.length === 0)
        {
            throw new ReleaseCliUsageError(ReleasePublishCli.MissingEnvPrefix + name)
        }
        return value
    }
}
