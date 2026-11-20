import type { AppShellConfig } from '../config/app-shell-config.js'

/** The `SessionEndpoint` reply: the session's subject and its multi-valued claims. Field names mirror the wire. */
export interface AppSessionWire
{
    readonly subject: string
    readonly claims?: Readonly<Record<string, readonly string[]>>
}

/**
 * The signed-in session as the host reported it: a generic subject plus claims (email, roles, the tenant, ...).
 * Roles are read from the configured claims the host's `ClaimsAuthorizer` checks: the tenant roles (`roles`) and this
 * application's roles (`app_roles`). The browser only
 * uses them to explain and pre-disable; the host stays the gate.
 */
export class AppSession
{
    private static readonly NoSubject = 'AppSession: the session reply carries no subject'
    private static readonly NoEmail = ''

    private constructor(
        public readonly Subject: string,
        public readonly Claims: Readonly<Record<string, readonly string[]>>,
        private readonly config: AppShellConfig)
    {
    }

    public static FromWire(wire: AppSessionWire, config: AppShellConfig): AppSession
    {
        if (typeof wire?.subject !== 'string' || wire.subject.length === 0)
        {
            throw new Error(AppSession.NoSubject)
        }
        return new AppSession(wire.subject, AppSession.CleanClaims(wire.claims), config)
    }

    /** The claim's first value; undefined when absent. */
    public Claim(name: string): string | undefined
    {
        return this.Values(name)[0]
    }

    /** Every value of the claim; empty when absent. */
    public Values(name: string): readonly string[]
    {
        return this.Claims[name] ?? []
    }

    /** The email claim; '' when the session carries none. */
    public get Email(): string
    {
        return this.Claim(this.config.EmailClaim) ?? AppSession.NoEmail
    }

    public get Roles(): readonly string[]
    {
        return this.Values(this.config.RolesClaim)
    }

    public HasRole(role: string): boolean
    {
        return this.Roles.includes(role)
    }

    /** True when the session holds at least one of `roles` (a route that lists several roles admits any one). */
    public HasAnyRole(roles: readonly string[]): boolean
    {
        return roles.some(role => this.HasRole(role))
    }

    /** This application's roles, by bare name. */
    public get AppRoles(): readonly string[]
    {
        return this.Values(this.config.AppRolesClaim)
    }

    public HasAppRole(role: string): boolean
    {
        return this.AppRoles.includes(role)
    }

    /** True when the session holds at least one of this application's `roles`. */
    public HasAnyAppRole(roles: readonly string[]): boolean
    {
        return roles.some(role => this.HasAppRole(role))
    }

    private static CleanClaims(claims: unknown): Record<string, readonly string[]>
    {
        const clean: Record<string, readonly string[]> = {}
        if (typeof claims !== 'object' || claims === null)
        {
            return clean
        }
        for (const [name, values] of Object.entries(claims))
        {
            if (Array.isArray(values))
            {
                clean[name] = Object.freeze(values.filter((value): value is string => typeof value === 'string'))
            }
        }
        return Object.freeze(clean)
    }
}
