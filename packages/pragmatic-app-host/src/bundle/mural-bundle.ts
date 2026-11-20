import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'

/** A bundle file, ready to write. */
class BundleFile
{
    public constructor(public readonly Bytes: Buffer, public readonly ContentType: string, public readonly CacheControl: string)
    {
    }
}

/**
 * The application's built Mural UI, from an explicit root. Every file is read once at Load (the build does not change
 * while the process runs) and looked up by its exact `/`-separated relative path, so no request path can reach outside
 * the root; a path with a `..`, `.` or empty segment, a backslash, a NUL or a malformed escape is 404. The index is
 * served at `/` and, for a client route (a GET whose last segment has no extension), as the SPA fallback, with
 * `no-cache`; content-hashed scripts and styles are `immutable`; other files revalidate hourly. GET and HEAD only.
 */
export class MuralBundle
{
    private static readonly IndexFile = 'index.html'
    private static readonly UrlSeparator = '/'
    private static readonly ExtensionSeparator = '.'
    private static readonly Backslash = '\\'
    private static readonly Nul = '\u0000'
    private static readonly ParentSegment = '..'
    private static readonly CurrentSegment = '.'
    private static readonly MethodGet = 'GET'
    private static readonly MethodHead = 'HEAD'
    private static readonly StatusOk = 200
    private static readonly StatusNotFound = 404
    private static readonly StatusMethodNotAllowed = 405
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly ContentLengthHeader = 'Content-Length'
    private static readonly CacheControlHeader = 'Cache-Control'
    private static readonly AllowHeader = 'Allow'
    private static readonly AllowedMethods = 'GET, HEAD'
    private static readonly TextType = 'text/plain; charset=utf-8'
    private static readonly NotFoundBody = 'Not found'
    private static readonly MethodNotAllowedBody = 'Method not allowed'
    private static readonly NoCache = 'no-cache'
    private static readonly ImmutableCache = 'public, max-age=31536000, immutable'
    private static readonly HourCache = 'public, max-age=3600'
    private static readonly HashedName = /-[A-Za-z0-9_-]{8,}\.(?:js|mjs|css)$/
    private static readonly OctetStream = 'application/octet-stream'
    private static readonly NotBuiltMessage = 'MuralBundle: the bundle root has no index.html: '
    private static readonly ContentTypes: ReadonlyMap<string, string> = new Map([
        ['.html', 'text/html; charset=utf-8'],
        ['.js', 'text/javascript; charset=utf-8'],
        ['.mjs', 'text/javascript; charset=utf-8'],
        ['.css', 'text/css; charset=utf-8'],
        ['.json', 'application/json; charset=utf-8'],
        ['.map', 'application/json; charset=utf-8'],
        ['.svg', 'image/svg+xml'],
        ['.png', 'image/png'],
        ['.jpg', 'image/jpeg'],
        ['.jpeg', 'image/jpeg'],
        ['.gif', 'image/gif'],
        ['.webp', 'image/webp'],
        ['.ico', 'image/x-icon'],
        ['.woff', 'font/woff'],
        ['.woff2', 'font/woff2'],
        ['.txt', 'text/plain; charset=utf-8'],
        ['.wasm', 'application/wasm'],
    ])

    private constructor(private readonly index: BundleFile, private readonly files: ReadonlyMap<string, BundleFile>)
    {
    }

    /** The bundle built at `root`; throws when it has no index.html. */
    public static Load(root: string): MuralBundle
    {
        const absolute = resolve(root)
        const indexPath = join(absolute, MuralBundle.IndexFile)
        if (!existsSync(indexPath))
        {
            throw new Error(MuralBundle.NotBuiltMessage + absolute)
        }
        const files = new Map<string, BundleFile>()
        for (const entry of readdirSync(absolute, { recursive: true, withFileTypes: true }))
        {
            if (!entry.isFile())
            {
                continue
            }
            const full = join(entry.parentPath, entry.name)
            const key = relative(absolute, full).split(sep).join(MuralBundle.UrlSeparator)
            files.set(key, MuralBundle.FileOf(full, key))
        }
        const index = files.get(MuralBundle.IndexFile) as BundleFile
        return new MuralBundle(new BundleFile(index.Bytes, index.ContentType, MuralBundle.NoCache), files)
    }

    /** Answers a request for `path` (the URL path, query stripped). */
    public Serve(req: IncomingMessage, res: ServerResponse, path: string): void
    {
        const method = (req.method ?? MuralBundle.MethodGet).toUpperCase()
        if (method !== MuralBundle.MethodGet && method !== MuralBundle.MethodHead)
        {
            res.writeHead(MuralBundle.StatusMethodNotAllowed, { [MuralBundle.ContentTypeHeader]: MuralBundle.TextType, [MuralBundle.AllowHeader]: MuralBundle.AllowedMethods })
            res.end(MuralBundle.MethodNotAllowedBody)
            return
        }
        const file = this.Resolve(path)
        if (file === undefined)
        {
            res.writeHead(MuralBundle.StatusNotFound, { [MuralBundle.ContentTypeHeader]: MuralBundle.TextType })
            res.end(MuralBundle.NotFoundBody)
            return
        }
        res.writeHead(MuralBundle.StatusOk, {
            [MuralBundle.ContentTypeHeader]: file.ContentType,
            [MuralBundle.ContentLengthHeader]: file.Bytes.length,
            [MuralBundle.CacheControlHeader]: file.CacheControl,
        })
        res.end(method === MuralBundle.MethodHead ? undefined : file.Bytes)
    }

    private Resolve(path: string): BundleFile | undefined
    {
        if (path === MuralBundle.UrlSeparator)
        {
            return this.index
        }
        let decoded: string
        try
        {
            decoded = decodeURIComponent(path)
        }
        catch
        {
            return undefined
        }
        if (!decoded.startsWith(MuralBundle.UrlSeparator) || decoded.includes(MuralBundle.Backslash) || decoded.includes(MuralBundle.Nul))
        {
            return undefined
        }
        const segments = decoded.slice(1).split(MuralBundle.UrlSeparator)
        if (segments.some(segment => segment === '' || segment === MuralBundle.ParentSegment || segment === MuralBundle.CurrentSegment))
        {
            return undefined
        }
        const key = segments.join(MuralBundle.UrlSeparator)
        if (key === MuralBundle.IndexFile)
        {
            return this.index
        }
        const file = this.files.get(key)
        if (file !== undefined)
        {
            return file
        }
        const last = segments[segments.length - 1] as string
        return last.includes(MuralBundle.ExtensionSeparator) ? undefined : this.index
    }

    private static FileOf(full: string, key: string): BundleFile
    {
        const type = MuralBundle.ContentTypes.get(extname(full).toLowerCase()) ?? MuralBundle.OctetStream
        return new BundleFile(readFileSync(full), type, MuralBundle.HashedName.test(key) ? MuralBundle.ImmutableCache : MuralBundle.HourCache)
    }
}
