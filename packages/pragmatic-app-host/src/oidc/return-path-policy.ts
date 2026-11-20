/**
 * Which paths a sign-in may return to: a plain path on the application's own origin (it starts with one `/`, holds no
 * scheme, backslash, dot segment, encoded slash or backslash, fragment, whitespace or control character, and is at
 * most 2048 characters) under one of the allow-listed prefixes. A prefix matches at a segment boundary (`/register`
 * admits `/register` and `/register/step-2`, not `/registered`); `/` admits every plain path. The query is kept.
 * Anything else is refused (null), and the sign-in then lands on its default.
 */
export class ReturnPathPolicy
{
    private static readonly MaxLength = 2048
    private static readonly Slash = '/'
    private static readonly QueryMark = '?'
    private static readonly Base = 'https://return-path.invalid'
    private static readonly Forbidden = /[\\#\s\u0000-\u001f\u007f]|%2f|%5c|%2e/i
    private static readonly BadPrefixMessage = 'ReturnPathPolicy: a return path prefix must be a plain absolute path: '

    private readonly prefixes: readonly string[]

    public constructor(prefixes: readonly string[])
    {
        for (const prefix of prefixes)
        {
            if (prefix.includes(ReturnPathPolicy.QueryMark) || ReturnPathPolicy.Plain(prefix) === null)
            {
                throw new Error(ReturnPathPolicy.BadPrefixMessage + JSON.stringify(prefix))
            }
        }
        this.prefixes = [...prefixes]
    }

    /** The path to return to, or null when `raw` is not one this policy admits. */
    public Admit(raw: string): string | null
    {
        const plain = ReturnPathPolicy.Plain(raw)
        if (plain === null)
        {
            return null
        }
        return this.prefixes.some(prefix => ReturnPathPolicy.Under(plain.pathname, prefix)) ? plain.pathname + plain.search : null
    }

    /** Whether `raw` is a plain path (with an optional query) on the own origin, whatever the prefixes. */
    public static IsPlain(raw: string): boolean
    {
        return ReturnPathPolicy.Plain(raw) !== null
    }

    private static Under(path: string, prefix: string): boolean
    {
        const S = ReturnPathPolicy.Slash
        return path === prefix || path.startsWith(prefix.endsWith(S) ? prefix : prefix + S)
    }

    /** `raw` parsed as a path on the own origin, when it is a plain one: parsing changes nothing but adds the origin. */
    private static Plain(raw: string): URL | null
    {
        const R = ReturnPathPolicy
        if (raw.length === 0 || raw.length > R.MaxLength || !raw.startsWith(R.Slash) || raw.startsWith(R.Slash + R.Slash) || R.Forbidden.test(raw))
        {
            return null
        }
        let url: URL
        try
        {
            url = new URL(raw, R.Base)
        }
        catch
        {
            return null
        }
        return url.origin === R.Base && url.pathname + url.search === raw ? url : null
    }
}
