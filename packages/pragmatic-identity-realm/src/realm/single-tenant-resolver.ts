import type { IRealmResolver, Realm } from "@pragmatic-tech-ai/pragmatic-identity";

export class SingleRealmResolver implements IRealmResolver
{
    private readonly realm: Realm;

    public constructor(realm: Realm)
    {
        this.realm = realm;
    }

    public async Resolve(_hint: string): Promise<Realm | null>
    {
        return this.realm;
    }
}
