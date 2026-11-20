import { RealmRoleClaims } from '@pragmatic-tech-ai/pragmatic-identity'
import type { GroupStrategy } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'

/** Reads a realm-issued id token's role claims (RealmRoleClaims: `roles` and `app_roles`) as the principal's groups,
 *  in their qualified form (`admin`, `ledger:finance`); the relying party splits them back into session claims. */
export class RealmRoleGroupStrategy implements GroupStrategy
{
    public constructor(private readonly rolesClaim: string = RealmRoleClaims.RolesClaim)
    {
    }

    public GroupsFrom(payload: Record<string, unknown>): readonly string[]
    {
        return RealmRoleClaims.FromPayload(payload, this.rolesClaim).Qualified()
    }
}
