import type { ApplicationDeclaration, IApplicationCatalogue } from "@pragmatic-tech-ai/pragmatic-identity";

/** The application catalogue in memory (tests, single-process hosts). */
export class InMemoryApplicationCatalogue implements IApplicationCatalogue
{
    private readonly realms = new Map<string, Map<string, ApplicationDeclaration>>();

    public async Applications(realmId: string): Promise<readonly ApplicationDeclaration[]>
    {
        return [...(this.realms.get(realmId)?.values() ?? [])].sort((a, b) => (a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0));
    }

    public async Application(realmId: string, name: string): Promise<ApplicationDeclaration | null>
    {
        return this.realms.get(realmId)?.get(name) ?? null;
    }

    public async Declare(realmId: string, application: ApplicationDeclaration): Promise<void>
    {
        let applications = this.realms.get(realmId);
        if (applications === undefined)
        {
            applications = new Map();
            this.realms.set(realmId, applications);
        }
        applications.set(application.Name, application);
    }

    public async Remove(realmId: string, name: string): Promise<boolean>
    {
        return this.realms.get(realmId)?.delete(name) ?? false;
    }
}
