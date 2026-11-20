import { RealmRole } from "@pragmatic-tech-ai/pragmatic-identity";
import type { IApplicationCatalogue, IRoleMappingStore, RoleMapping } from "@pragmatic-tech-ai/pragmatic-identity";
import type { TenantRoleRegistry } from "./tenant-role-registry.js";

/** Why a mapping was refused. */
export enum RoleMappingErrorReason
{
    /** The tenant role is not one of the predefined tenant roles. */
    UnknownTenantRole = "unknown-tenant-role",
    /** The application role names an application the realm does not know. */
    UnknownApplication = "unknown-application",
    /** The application is known but does not declare the role. */
    UndeclaredApplicationRole = "undeclared-application-role",
    /** The member names no value, or a group/user without its source (or an account with one). */
    InvalidMember = "invalid-member",
}

/** A refused role mapping. */
export class RoleMappingError extends Error
{
    private static readonly Messages: Readonly<Record<RoleMappingErrorReason, string>> = {
        [RoleMappingErrorReason.UnknownTenantRole]: "unknown tenant role ",
        [RoleMappingErrorReason.UnknownApplication]: "unknown application in role ",
        [RoleMappingErrorReason.UndeclaredApplicationRole]: "the application does not declare the role ",
        [RoleMappingErrorReason.InvalidMember]: "invalid member for role ",
    };

    public constructor(public readonly Reason: RoleMappingErrorReason, public readonly Role: string)
    {
        super(RoleMappingError.Messages[Reason] + Role);
        this.name = RoleMappingError.name;
    }
}

/** A role the tenant admin can map: a tenant role or a role an application of the realm declares. */
export class AssignableRole
{
    public constructor(
        public readonly Role: RealmRole,
        public readonly Description: string,
    )
    {
        Object.freeze(this);
    }
}

/**
 * The tenant admin's side of role mapping: which roles can be mapped, and adding, removing and listing a realm's
 * mappings. Adding validates: a tenant role must be predefined, an application role must be declared by an
 * application the realm knows, the member must be well formed. Removing never validates (a mapping left stale by an
 * application's new release can always be removed). Members are not checked against the realm's sources: a mapping
 * for a source the realm does not have is inert, since resolution grants nothing from an unknown source.
 */
export class RoleMappingService
{
    public constructor(
        private readonly tenantRoles: TenantRoleRegistry,
        private readonly applications: IApplicationCatalogue,
        private readonly mappings: IRoleMappingStore,
    )
    {
    }

    /** The tenant roles, then every application's declared roles, by application. */
    public async AssignableRoles(realmId: string): Promise<readonly AssignableRole[]>
    {
        const roles = this.tenantRoles.Roles.map(role => new AssignableRole(RealmRole.Tenant(role.Name), role.Description));
        for (const application of await this.applications.Applications(realmId))
        {
            for (const role of application.Roles)
            {
                roles.push(new AssignableRole(RealmRole.OfApplication(application.Name, role.Name), role.Description));
            }
        }
        return roles;
    }

    public async List(realmId: string): Promise<readonly RoleMapping[]>
    {
        return this.mappings.MappingsFor(realmId);
    }

    /** True when the mapping was new; throws RoleMappingError when it is refused. */
    public async Add(realmId: string, mapping: RoleMapping): Promise<boolean>
    {
        await this.Validate(realmId, mapping);
        return this.mappings.Add(realmId, mapping);
    }

    /** True when the mapping existed. */
    public async Remove(realmId: string, mapping: RoleMapping): Promise<boolean>
    {
        return this.mappings.Remove(realmId, mapping);
    }

    public async Validate(realmId: string, mapping: RoleMapping): Promise<void>
    {
        const role = mapping.Role;
        const text = role.ToString();
        if (!mapping.Member.IsWellFormed)
        {
            throw new RoleMappingError(RoleMappingErrorReason.InvalidMember, text);
        }
        if (role.IsTenantRole)
        {
            if (!this.tenantRoles.Has(role.Name))
            {
                throw new RoleMappingError(RoleMappingErrorReason.UnknownTenantRole, text);
            }
            return;
        }
        const application = await this.applications.Application(realmId, role.Application);
        if (application === null)
        {
            throw new RoleMappingError(RoleMappingErrorReason.UnknownApplication, text);
        }
        if (!application.Declares(role.Name))
        {
            throw new RoleMappingError(RoleMappingErrorReason.UndeclaredApplicationRole, text);
        }
    }
}
