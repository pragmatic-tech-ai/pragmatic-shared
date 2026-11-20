/**
 * What a session knows about its subject, as the realm issued it: named, multi-valued string claims (an email, the
 * tenant, the tenant and application roles). Immutable; serialises as `{ name: [values] }`.
 */
export class SessionClaims
{
    public static readonly Empty = new SessionClaims(new Map())

    private constructor(private readonly claims: ReadonlyMap<string, readonly string[]>)
    {
    }

    public static From(values: Record<string, string | readonly string[]>): SessionClaims
    {
        const claims = new Map<string, readonly string[]>()
        for (const [name, value] of Object.entries(values))
        {
            claims.set(name, typeof value === 'string' ? [value] : [...value])
        }
        return new SessionClaims(claims)
    }

    /** Claims from their serialised form; values that are not strings are dropped, unparseable text is empty. */
    public static FromJson(text: string): SessionClaims
    {
        let parsed: unknown
        try
        {
            parsed = JSON.parse(text)
        }
        catch
        {
            return SessionClaims.Empty
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        {
            return SessionClaims.Empty
        }
        const claims = new Map<string, readonly string[]>()
        for (const [name, value] of Object.entries(parsed as Record<string, unknown>))
        {
            if (typeof value === 'string')
            {
                claims.set(name, [value])
            }
            else if (Array.isArray(value))
            {
                claims.set(name, value.filter((v): v is string => typeof v === 'string'))
            }
        }
        return new SessionClaims(claims)
    }

    public Names(): readonly string[]
    {
        return [...this.claims.keys()]
    }

    public Values(name: string): readonly string[]
    {
        return this.claims.get(name) ?? []
    }

    public First(name: string): string | undefined
    {
        return this.claims.get(name)?.[0]
    }

    public Has(name: string, value: string): boolean
    {
        return this.Values(name).includes(value)
    }

    public With(name: string, values: readonly string[]): SessionClaims
    {
        const claims = new Map(this.claims)
        claims.set(name, [...values])
        return new SessionClaims(claims)
    }

    public ToJson(): Record<string, string[]>
    {
        return Object.fromEntries([...this.claims].map(([name, values]) => [name, [...values]]))
    }
}
