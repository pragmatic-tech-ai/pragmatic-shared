import { RoleMapping } from "@pragmatic-tech-ai/pragmatic-identity";
import type { IRoleMappingStore } from "@pragmatic-tech-ai/pragmatic-identity";

/** The role mappings in memory (tests, single-process hosts). */
export class InMemoryRoleMappingStore implements IRoleMappingStore
{
    private readonly realms = new Map<string, Map<string, RoleMapping>>();

    public async MappingsFor(realmId: string): Promise<readonly RoleMapping[]>
    {
        return RoleMapping.Sorted(this.realms.get(realmId)?.values() ?? []);
    }

    public async Add(realmId: string, mapping: RoleMapping): Promise<boolean>
    {
        let mappings = this.realms.get(realmId);
        if (mappings === undefined)
        {
            mappings = new Map();
            this.realms.set(realmId, mappings);
        }
        if (mappings.has(mapping.Key()))
        {
            return false;
        }
        mappings.set(mapping.Key(), mapping);
        return true;
    }

    public async Remove(realmId: string, mapping: RoleMapping): Promise<boolean>
    {
        return this.realms.get(realmId)?.delete(mapping.Key()) ?? false;
    }
}
