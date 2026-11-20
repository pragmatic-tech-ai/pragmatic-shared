/**
 * A route path pattern: `/`-separated segments, each a literal, a `:name` parameter (one non-empty segment,
 * percent-decoded once) or, as the last segment only, `*` (the rest of the path, at least one segment, kept raw under
 * the name `*`). Matching is on the exact segment count; a trailing slash is a distinct path.
 */
export class RoutePattern
{
    public static readonly RestName = '*'
    private static readonly Separator = '/'
    private static readonly ParamPrefix = ':'
    private static readonly LeadingSlashMessage = 'A route pattern must start with /: '
    private static readonly RestLastMessage = 'A * segment may only end a route pattern: '

    private readonly segments: readonly string[]
    private readonly hasRest: boolean
    /** How many segments are literals: a more literal pattern wins over a more general one. */
    public readonly Specificity: number

    public constructor(public readonly Text: string)
    {
        if (!Text.startsWith(RoutePattern.Separator))
        {
            throw new Error(RoutePattern.LeadingSlashMessage + Text)
        }
        const segments = Text.slice(1).split(RoutePattern.Separator)
        const restAt = segments.indexOf(RoutePattern.RestName)
        if (restAt >= 0 && restAt !== segments.length - 1)
        {
            throw new Error(RoutePattern.RestLastMessage + Text)
        }
        this.hasRest = restAt >= 0
        this.segments = this.hasRest ? segments.slice(0, -1) : segments
        this.Specificity = this.segments.filter(segment => !segment.startsWith(RoutePattern.ParamPrefix)).length
    }

    /** The parameters when `path` matches, else null. */
    public Match(path: string): ReadonlyMap<string, string> | null
    {
        if (!path.startsWith(RoutePattern.Separator))
        {
            return null
        }
        const parts = path.slice(1).split(RoutePattern.Separator)
        if (this.hasRest ? parts.length <= this.segments.length : parts.length !== this.segments.length)
        {
            return null
        }
        const params = new Map<string, string>()
        for (let i = 0; i < this.segments.length; i++)
        {
            const segment = this.segments[i] as string
            const part = parts[i] as string
            if (!segment.startsWith(RoutePattern.ParamPrefix))
            {
                if (segment !== part)
                {
                    return null
                }
                continue
            }
            const value = RoutePattern.Decode(part)
            if (value === null || value.length === 0)
            {
                return null
            }
            params.set(segment.slice(RoutePattern.ParamPrefix.length), value)
        }
        if (this.hasRest)
        {
            params.set(RoutePattern.RestName, parts.slice(this.segments.length).join(RoutePattern.Separator))
        }
        return params
    }

    private static Decode(part: string): string | null
    {
        try
        {
            return decodeURIComponent(part)
        }
        catch
        {
            return null
        }
    }
}
