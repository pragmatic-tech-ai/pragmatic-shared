/**
 * Where a platform release reads what each container repository's image release published: the `component.json` asset
 * attached to the repository's GitHub release `v<version>` (the descriptor its image carries) and the commit that tag
 * names. `repository` is `<owner>/<name>`. Both answer undefined when the release, the asset or the tag does not exist;
 * a source that cannot be asked throws.
 */
export interface IComponentAssetSource
{
    ComponentAsset(repository: string, version: string): Promise<Uint8Array | undefined>
    ReleaseCommit(repository: string, version: string): Promise<string | undefined>
}

/** GitHub could not be asked, or answered something unreadable. One fixed sentence; never the response body or a token. */
export class ComponentAssetUnavailableError extends Error
{
    private static readonly ErrorName = 'ComponentAssetUnavailableError'

    public constructor(message: string)
    {
        super(message)
        this.name = ComponentAssetUnavailableError.ErrorName
    }
}

export type GitHubRequestInit = { method: string; headers: Record<string, string>; redirect: 'manual' | 'follow' }

export type GitHubFetch = (url: string, init: GitHubRequestInit) => Promise<Response>

/**
 * IComponentAssetSource over the GitHub REST API (an injectable fetch seam). The release is read by tag
 * (`/repos/<repository>/releases/tags/v<version>`), the asset by its API URL as an octet stream: the API answers with a
 * redirect to the download host, which is followed by hand and without the token, so the token is only ever sent to the
 * API origin. The commit is `/repos/<repository>/commits/v<version>` as a bare sha. An optional token lifts the anonymous
 * rate limit (and reads private repositories). Imports only node builtins.
 */
export class GitHubComponentAssetSource implements IComponentAssetSource
{
    public static readonly DefaultApi = 'https://api.github.com'
    /** The asset name every container release attaches (pragmatic-shared's container-release.yml). */
    public static readonly AssetName = 'component.json'
    /** A component descriptor is a few kilobytes; anything past this is not one. */
    public static readonly MaxAssetBytes = 1024 * 1024
    private static readonly TagPrefix = 'v'
    private static readonly ReposPath = '/repos/'
    private static readonly ReleaseByTagPath = '/releases/tags/'
    private static readonly CommitsPath = '/commits/'
    private static readonly PathSeparator = '/'
    private static readonly MethodGet = 'GET'
    private static readonly AcceptHeader = 'Accept'
    private static readonly AuthorizationHeader = 'Authorization'
    private static readonly ApiVersionHeader = 'X-GitHub-Api-Version'
    private static readonly UserAgentHeader = 'User-Agent'
    private static readonly LocationHeader = 'location'
    private static readonly ContentLengthHeader = 'content-length'
    private static readonly TrailingSlashes = /\/+$/
    private static readonly JsonType = 'application/vnd.github+json'
    private static readonly ShaType = 'application/vnd.github.sha'
    private static readonly OctetStream = 'application/octet-stream'
    private static readonly ApiVersion = '2022-11-28'
    private static readonly UserAgent = 'pragmatic-release-toolkit'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly HttpsProtocol = 'https:'
    private static readonly RedirectManual = 'manual'
    private static readonly StatusOk = 200
    private static readonly StatusNotFound = 404
    /** GitHub answers 422 for a commit ref that names nothing. */
    private static readonly StatusUnprocessable = 422
    private static readonly RedirectStatuses: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])
    private static readonly CommitPattern = /^[0-9a-f]{40}$/
    private static readonly RepositoryPattern = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
    private static readonly UnreachableMessage = 'GitHub is unreachable'
    private static readonly StatusMessagePrefix = 'GitHub answered HTTP '
    private static readonly UnreadableMessage = 'GitHub answered something that is not a release, asset or commit'
    private static readonly TooLargeMessage = 'The component.json asset is larger than a component descriptor can be'
    private static readonly BadRepositoryMessage = 'The repository must be <owner>/<name>'
    private static readonly BadRedirectMessage = 'GitHub redirected the asset download somewhere that is not https'
    private static readonly GlobalFetch: GitHubFetch = (url, init) => fetch(url, init as RequestInit)

    /** The API base without a trailing slash (`https://api.github.com`, a GHES `https://host/api/v3`). */
    private readonly api: string
    /** The origin the token is sent to, and the only one an asset API URL may name. */
    private readonly apiOrigin: string

    public constructor(
        private readonly fetchFn: GitHubFetch = GitHubComponentAssetSource.GlobalFetch,
        private readonly token?: string,
        api: string = GitHubComponentAssetSource.DefaultApi,
    )
    {
        const base = new URL(api)
        this.apiOrigin = base.origin
        this.api = base.origin + base.pathname.replace(GitHubComponentAssetSource.TrailingSlashes, '')
    }

    public async ComponentAsset(repository: string, version: string): Promise<Uint8Array | undefined>
    {
        const S = GitHubComponentAssetSource
        const response = await this.Get(this.RepoUrl(repository) + S.ReleaseByTagPath + S.TagOf(version), S.JsonType)
        if (response.status === S.StatusNotFound)
        {
            await S.Drain(response)
            return undefined
        }
        await S.Expect(response, S.StatusOk)
        const assetUrl = S.AssetUrlOf(await S.ReadJson(response))
        if (assetUrl === undefined)
        {
            return undefined
        }
        if (new URL(assetUrl).origin !== this.apiOrigin)
        {
            throw new ComponentAssetUnavailableError(S.UnreadableMessage)
        }
        return this.Download(assetUrl)
    }

    public async ReleaseCommit(repository: string, version: string): Promise<string | undefined>
    {
        const S = GitHubComponentAssetSource
        const response = await this.Get(this.RepoUrl(repository) + S.CommitsPath + S.TagOf(version), S.ShaType)
        if (response.status === S.StatusNotFound || response.status === S.StatusUnprocessable)
        {
            await S.Drain(response)
            return undefined
        }
        await S.Expect(response, S.StatusOk)
        const sha = (await S.ReadText(response)).trim()
        if (!S.CommitPattern.test(sha))
        {
            throw new ComponentAssetUnavailableError(S.UnreadableMessage)
        }
        return sha
    }

    /** The asset bytes: the API's redirect is followed once, by hand, to an https download URL that gets no token. */
    private async Download(assetUrl: string): Promise<Uint8Array>
    {
        const S = GitHubComponentAssetSource
        const first = await this.Get(assetUrl, S.OctetStream)
        if (!S.RedirectStatuses.has(first.status))
        {
            await S.Expect(first, S.StatusOk)
            return S.ReadAsset(first)
        }
        const location = first.headers.get(S.LocationHeader)
        await S.Drain(first)
        if (location === null)
        {
            throw new ComponentAssetUnavailableError(S.BadRedirectMessage)
        }
        let target: URL
        try
        {
            target = new URL(location, assetUrl)
        }
        catch
        {
            throw new ComponentAssetUnavailableError(S.BadRedirectMessage)
        }
        if (target.protocol !== S.HttpsProtocol)
        {
            throw new ComponentAssetUnavailableError(S.BadRedirectMessage)
        }
        const second = await this.Send(target.toString(), { [S.AcceptHeader]: S.OctetStream, [S.UserAgentHeader]: S.UserAgent })
        await S.Expect(second, S.StatusOk)
        return S.ReadAsset(second)
    }

    /** An API request: the token (when given) is only ever attached here, for URLs on the API origin. */
    private Get(url: string, accept: string): Promise<Response>
    {
        const S = GitHubComponentAssetSource
        const headers: Record<string, string> = {
            [S.AcceptHeader]: accept,
            [S.ApiVersionHeader]: S.ApiVersion,
            [S.UserAgentHeader]: S.UserAgent,
        }
        if (this.token !== undefined && this.token.length > 0 && new URL(url).origin === this.apiOrigin)
        {
            headers[S.AuthorizationHeader] = S.BearerPrefix + this.token
        }
        return this.Send(url, headers)
    }

    private async Send(url: string, headers: Record<string, string>): Promise<Response>
    {
        try
        {
            return await this.fetchFn(url, { method: GitHubComponentAssetSource.MethodGet, headers, redirect: GitHubComponentAssetSource.RedirectManual })
        }
        catch
        {
            throw new ComponentAssetUnavailableError(GitHubComponentAssetSource.UnreachableMessage)
        }
    }

    private RepoUrl(repository: string): string
    {
        const S = GitHubComponentAssetSource
        if (!S.RepositoryPattern.test(repository))
        {
            throw new ComponentAssetUnavailableError(S.BadRepositoryMessage)
        }
        const [owner, name] = repository.split(S.PathSeparator)
        return this.api + S.ReposPath + encodeURIComponent(owner) + S.PathSeparator + encodeURIComponent(name)
    }

    private static TagOf(version: string): string
    {
        return encodeURIComponent(GitHubComponentAssetSource.TagPrefix + version)
    }

    /** The API URL of the release's `component.json` asset; undefined when the release has none. */
    private static AssetUrlOf(release: unknown): string | undefined
    {
        const S = GitHubComponentAssetSource
        if (typeof release !== 'object' || release === null || !Array.isArray((release as { assets?: unknown }).assets))
        {
            throw new ComponentAssetUnavailableError(S.UnreadableMessage)
        }
        for (const asset of (release as { assets: unknown[] }).assets)
        {
            if (typeof asset === 'object' && asset !== null && (asset as { name?: unknown }).name === S.AssetName)
            {
                const url = (asset as { url?: unknown }).url
                if (typeof url !== 'string')
                {
                    throw new ComponentAssetUnavailableError(S.UnreadableMessage)
                }
                return url
            }
        }
        return undefined
    }

    /** The body, refused once it passes MaxAssetBytes: by its declared length before reading, else while streaming it. */
    private static async ReadAsset(response: Response): Promise<Uint8Array>
    {
        const S = GitHubComponentAssetSource
        const declared = Number(response.headers.get(S.ContentLengthHeader) ?? 0)
        if (declared > S.MaxAssetBytes)
        {
            await S.Drain(response)
            throw new ComponentAssetUnavailableError(S.TooLargeMessage)
        }
        const reader = response.body?.getReader()
        if (reader === undefined)
        {
            return new Uint8Array()
        }
        const chunks: Uint8Array[] = []
        let total = 0
        try
        {
            for (let next = await reader.read(); !next.done; next = await reader.read())
            {
                total += next.value.length
                if (total > S.MaxAssetBytes)
                {
                    await reader.cancel()
                    throw new ComponentAssetUnavailableError(S.TooLargeMessage)
                }
                chunks.push(next.value)
            }
        }
        catch (error)
        {
            throw error instanceof ComponentAssetUnavailableError ? error : new ComponentAssetUnavailableError(S.UnreachableMessage)
        }
        const bytes = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks)
        {
            bytes.set(chunk, offset)
            offset += chunk.length
        }
        return bytes
    }

    private static async ReadJson(response: Response): Promise<unknown>
    {
        try
        {
            return await response.json()
        }
        catch
        {
            throw new ComponentAssetUnavailableError(GitHubComponentAssetSource.UnreadableMessage)
        }
    }

    private static async ReadText(response: Response): Promise<string>
    {
        try
        {
            return await response.text()
        }
        catch
        {
            throw new ComponentAssetUnavailableError(GitHubComponentAssetSource.UnreachableMessage)
        }
    }

    private static async Expect(response: Response, expected: number): Promise<void>
    {
        if (response.status !== expected)
        {
            await GitHubComponentAssetSource.Drain(response)
            throw new ComponentAssetUnavailableError(GitHubComponentAssetSource.StatusMessagePrefix + response.status)
        }
    }

    private static async Drain(response: Response): Promise<void>
    {
        try
        {
            await response.body?.cancel()
        }
        catch
        {
            // The body is discarded; a failed drain changes nothing.
        }
    }
}
