import type { RoleMapping } from "./role-mapping.js";

/** The role mappings of each realm. A mapping is a set member: adding it twice keeps one. */
export interface IRoleMappingStore
{
    /** Every mapping of the realm, in RoleMapping.Sorted order. */
    MappingsFor(realmId: string): Promise<readonly RoleMapping[]>;
    /** True when the mapping was new. */
    Add(realmId: string, mapping: RoleMapping): Promise<boolean>;
    /** True when the mapping existed. */
    Remove(realmId: string, mapping: RoleMapping): Promise<boolean>;
}
