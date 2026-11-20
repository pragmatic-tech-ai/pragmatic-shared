import type { RealmRole } from "./realm-role.js";
import type { RoleMember } from "./role-member.js";

/** One mapping of a realm: the role, and the upstream group, user or realm account that holds it. Immutable. */
export class RoleMapping
{
    private static readonly KeySeparator = "\u0001";

    public constructor(
        public readonly Role: RealmRole,
        public readonly Member: RoleMember,
    )
    {
        Object.freeze(this);
    }

    /** The mappings in their deterministic order (by role, then member). */
    public static Sorted(mappings: Iterable<RoleMapping>): readonly RoleMapping[]
    {
        return [...mappings].sort((a, b) => RoleMapping.Compare(a.Key(), b.Key()));
    }

    private static Compare(a: string, b: string): number
    {
        return a < b ? -1 : a > b ? 1 : 0;
    }

    /** The mapping's identity (role + member); also its sort key. */
    public Key(): string
    {
        return this.Role.ToString() + RoleMapping.KeySeparator + this.Member.Key();
    }

    public Equals(other: RoleMapping): boolean
    {
        return this.Key() === other.Key();
    }
}
