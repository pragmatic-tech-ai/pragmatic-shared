import { RealmRoleClaims, RoleMemberKind } from "@pragmatic-tech-ai/pragmatic-identity";
import type { ApplicationDeclaration, IApplicationCatalogue, IRoleMappingStore, RealmRole, RoleMapping } from "@pragmatic-tech-ai/pragmatic-identity";
import type { TenantRoleRegistry } from "./tenant-role-registry.js";

/** The realm a sign-in happens in, and the identity sources it has (the ids its configuration names). */
export class RealmRoleScope
{
    public readonly Sources: ReadonlySet<string>;

    public constructor(public readonly RealmId: string, sources: Iterable<string>)
    {
        this.Sources = new Set(sources);
        Object.freeze(this);
    }
}

/** What a sign-in established: the realm account, the source it came through, its subject there and its groups. */
export class SignInFacts
{
    public readonly Groups: readonly string[];

    public constructor(
        public readonly AccountId: string,
        public readonly Source: string,
        public readonly Subject: string,
        groups: Iterable<string>,
    )
    {
        this.Groups = Object.freeze([...groups]);
        Object.freeze(this);
    }
}

/**
 * Computes the realm roles of a sign-in, issued as `RealmRoleClaims`. Deny by default: a role is held only when a
 * mapping names it for this sign-in, and only while the role still exists (a predefined tenant role; an application
 * role its known application still declares). A sign-in through a source the realm does not have gets no role at all,
 * not even from an account mapping. Matching is exact (no case folding): a group mapping matches a group claim value of
 * the same source, a user mapping the same source and subject, an account mapping the realm account id. The result is
 * deterministic: sorted, unique, independent of mapping and group order.
 */
export class RealmRoleResolver
{
    public constructor(
        private readonly tenantRoles: TenantRoleRegistry,
        private readonly applications: IApplicationCatalogue,
        private readonly mappings: IRoleMappingStore,
    )
    {
    }

    public async Resolve(scope: RealmRoleScope, signIn: SignInFacts): Promise<RealmRoleClaims>
    {
        if (signIn.Source.length === 0 || !scope.Sources.has(signIn.Source))
        {
            return RealmRoleClaims.Empty;
        }
        const groups = new Set(signIn.Groups);
        const declarations = new Map<string, ApplicationDeclaration | null>();
        const held: RealmRole[] = [];
        for (const mapping of await this.mappings.MappingsFor(scope.RealmId))
        {
            if (RealmRoleResolver.Matches(mapping, signIn, groups) && await this.Exists(scope.RealmId, mapping.Role, declarations))
            {
                held.push(mapping.Role);
            }
        }
        return RealmRoleClaims.FromRoles(held);
    }

    private static Matches(mapping: RoleMapping, signIn: SignInFacts, groups: ReadonlySet<string>): boolean
    {
        const member = mapping.Member;
        if (!member.IsWellFormed)
        {
            return false;
        }
        switch (member.Kind)
        {
            case RoleMemberKind.SourceGroup:
                return member.Source === signIn.Source && groups.has(member.Value);
            case RoleMemberKind.SourceUser:
                return member.Source === signIn.Source && signIn.Subject.length > 0 && member.Value === signIn.Subject;
            case RoleMemberKind.Account:
                return signIn.AccountId.length > 0 && member.Value === signIn.AccountId;
            default:
                return false;
        }
    }

    private async Exists(realmId: string, role: RealmRole, declarations: Map<string, ApplicationDeclaration | null>): Promise<boolean>
    {
        if (role.IsTenantRole)
        {
            return this.tenantRoles.Has(role.Name);
        }
        if (!declarations.has(role.Application))
        {
            declarations.set(role.Application, await this.applications.Application(realmId, role.Application));
        }
        return declarations.get(role.Application)?.Declares(role.Name) ?? false;
    }
}
