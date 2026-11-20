import type { ApplicationDeclaration } from "./application-declaration.js";

/** The applications each realm knows and the roles they declare; the sign-in service feeds it from descriptors. */
export interface IApplicationCatalogue
{
    /** The realm's applications, by name. */
    Applications(realmId: string): Promise<readonly ApplicationDeclaration[]>;
    Application(realmId: string, name: string): Promise<ApplicationDeclaration | null>;
    /** Adds the application or replaces its declaration (a new release may add or drop roles). */
    Declare(realmId: string, application: ApplicationDeclaration): Promise<void>;
    /** True when the application was known. Its mappings stay, but grant nothing while it is unknown. */
    Remove(realmId: string, name: string): Promise<boolean>;
}
