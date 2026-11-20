import type { ISecretStore } from "@pragmatic-tech-ai/pragmatic-identity";

export class MapSecretStore implements ISecretStore
{
    private readonly map = new Map<string, string>();

    public async Get(reference: string): Promise<string | null>
    {
        return this.map.get(reference) ?? null;
    }

    public async Put(reference: string, secret: string): Promise<void>
    {
        this.map.set(reference, secret);
    }

    public async Delete(reference: string): Promise<void>
    {
        this.map.delete(reference);
    }
}
