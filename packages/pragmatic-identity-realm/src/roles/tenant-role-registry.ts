import { InvalidRealmRoleError, RealmRole } from "@pragmatic-tech-ai/pragmatic-identity";

/** One predefined tenant role. */
export class TenantRoleDeclaration
{
    public constructor(
        public readonly Name: string,
        public readonly Description: string,
    )
    {
        Object.freeze(this);
    }
}

/** A tenant role declared twice. */
export class DuplicateTenantRoleError extends Error
{
    private static readonly Prefix = "duplicate tenant role ";

    public constructor(public readonly Role: string)
    {
        super(DuplicateTenantRoleError.Prefix + Role);
        this.name = DuplicateTenantRoleError.name;
    }
}

/**
 * The predefined tenant roles (running the tenant). The list is data: adding a role is one more declaration in
 * `Standard` (or a registry built from configuration); mapping, resolution, claims and enforcement need no change.
 */
export class TenantRoleRegistry
{
    public static readonly Admin = "admin";
    private static readonly AdminDescription = "Runs the tenant: its realm, members, applications and environments.";

    public static readonly Standard = new TenantRoleRegistry([new TenantRoleDeclaration(TenantRoleRegistry.Admin, TenantRoleRegistry.AdminDescription)]);

    public readonly Roles: readonly TenantRoleDeclaration[];

    public constructor(roles: readonly TenantRoleDeclaration[])
    {
        const names = new Set<string>();
        for (const role of roles)
        {
            if (!RealmRole.IsRoleName(role.Name))
            {
                throw new InvalidRealmRoleError(role.Name);
            }
            if (names.has(role.Name))
            {
                throw new DuplicateTenantRoleError(role.Name);
            }
            names.add(role.Name);
        }
        this.Roles = Object.freeze([...roles].sort((a, b) => (a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0)));
        Object.freeze(this);
    }

    public Has(name: string): boolean
    {
        return this.Roles.some(role => role.Name === name);
    }

    public Role(name: string): TenantRoleDeclaration | undefined
    {
        return this.Roles.find(role => role.Name === name);
    }
}
