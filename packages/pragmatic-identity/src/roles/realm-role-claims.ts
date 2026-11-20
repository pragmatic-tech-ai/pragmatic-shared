import { RealmRole } from "./realm-role.js";

/** The wire form of the role claims: `roles` is an array, `app_roles` an object of arrays. */
export type RealmRoleClaimsPayload = Record<string, string[] | Record<string, string[]>>;

/**
 * The role claims a realm issues in its tokens, and how relying parties read them back. One home for the claim names
 * and shapes:
 *
 *   "roles":     ["admin"]                                   the tenant roles
 *   "app_roles": { "ledger": ["finance", "sales"] }          the application roles, by application
 *
 * Both claims are always present (an empty array / object when the subject holds none), names are sorted and unique,
 * and an application with no roles is left out. Reading is tolerant and strict at once: malformed entries (not a
 * string, not a well-formed role or application name) are dropped, never coerced.
 */
export class RealmRoleClaims
{
    public static readonly RolesClaim = "roles";
    public static readonly AppRolesClaim = "app_roles";
    public static readonly Empty = new RealmRoleClaims([], new Map());

    public readonly TenantRoles: readonly string[];
    public readonly ApplicationRoles: ReadonlyMap<string, readonly string[]>;

    public constructor(tenantRoles: Iterable<string>, applicationRoles: ReadonlyMap<string, Iterable<string>>)
    {
        this.TenantRoles = RealmRoleClaims.SortedUnique(tenantRoles);
        const applications = new Map<string, readonly string[]>();
        for (const application of RealmRoleClaims.SortedUnique(applicationRoles.keys()))
        {
            const roles = RealmRoleClaims.SortedUnique(applicationRoles.get(application) ?? []);
            if (roles.length > 0)
            {
                applications.set(application, roles);
            }
        }
        this.ApplicationRoles = applications;
        Object.freeze(this);
    }

    /** The claims holding exactly these realm roles. */
    public static FromRoles(roles: Iterable<RealmRole>): RealmRoleClaims
    {
        const tenant: string[] = [];
        const applications = new Map<string, string[]>();
        for (const role of roles)
        {
            if (role.IsTenantRole)
            {
                tenant.push(role.Name);
                continue;
            }
            let held = applications.get(role.Application);
            if (held === undefined)
            {
                held = [];
                applications.set(role.Application, held);
            }
            held.push(role.Name);
        }
        return new RealmRoleClaims(tenant, applications);
    }

    /** The claims from qualified role strings (`admin`, `ledger:finance`); malformed strings are dropped. */
    public static FromQualified(values: Iterable<string>): RealmRoleClaims
    {
        const roles: RealmRole[] = [];
        for (const value of values)
        {
            const role = RealmRole.TryParse(value);
            if (role !== null)
            {
                roles.push(role);
            }
        }
        return RealmRoleClaims.FromRoles(roles);
    }

    /** The claims a token payload carries (the claim names default to `roles` and `app_roles`). */
    public static FromPayload(payload: Record<string, unknown>, rolesClaim: string = RealmRoleClaims.RolesClaim, appRolesClaim: string = RealmRoleClaims.AppRolesClaim): RealmRoleClaims
    {
        const tenant = RealmRoleClaims.Strings(payload[rolesClaim]).filter(name => RealmRole.IsRoleName(name));
        const applications = new Map<string, string[]>();
        const appRoles = payload[appRolesClaim];
        if (appRoles !== null && typeof appRoles === "object" && !Array.isArray(appRoles))
        {
            for (const [application, roles] of Object.entries(appRoles as Record<string, unknown>))
            {
                if (RealmRole.IsApplicationName(application))
                {
                    applications.set(application, RealmRoleClaims.Strings(roles).filter(name => RealmRole.IsRoleName(name)));
                }
            }
        }
        return new RealmRoleClaims(tenant, applications);
    }

    private static Strings(value: unknown): string[]
    {
        return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    }

    private static SortedUnique(values: Iterable<string>): readonly string[]
    {
        return Object.freeze([...new Set(values)].sort());
    }

    /** The roles the subject holds in one application; empty when none. */
    public RolesOf(application: string): readonly string[]
    {
        return this.ApplicationRoles.get(application) ?? [];
    }

    public get IsEmpty(): boolean
    {
        return this.TenantRoles.length === 0 && this.ApplicationRoles.size === 0;
    }

    /** Every role as a qualified string: the tenant roles, then `<application>:<role>` by application. */
    public Qualified(): readonly string[]
    {
        const qualified = [...this.TenantRoles];
        for (const [application, roles] of this.ApplicationRoles)
        {
            for (const role of roles)
            {
                qualified.push(application + RealmRole.Separator + role);
            }
        }
        return qualified;
    }

    /** The token claims: `{ roles: [...], app_roles: { <application>: [...] } }`. */
    public ToPayload(): RealmRoleClaimsPayload
    {
        const appRoles: Record<string, string[]> = {};
        for (const [application, roles] of this.ApplicationRoles)
        {
            appRoles[application] = [...roles];
        }
        return { [RealmRoleClaims.RolesClaim]: [...this.TenantRoles], [RealmRoleClaims.AppRolesClaim]: appRoles };
    }
}
