/** The shape an application's roles are read from: a component descriptor (`ComponentDescriptor` satisfies it). */
export interface IApplicationRoleSource
{
    readonly Name: string;
    readonly Roles: readonly { readonly Name: string; readonly Description: string }[];
}

/** One role an application declares. */
export class ApplicationRoleDeclaration
{
    public constructor(
        public readonly Name: string,
        public readonly Description: string,
    )
    {
        Object.freeze(this);
    }
}

/** An application of the realm and the roles it declares (from its component descriptor). Immutable; roles by name. */
export class ApplicationDeclaration
{
    public readonly Roles: readonly ApplicationRoleDeclaration[];

    public constructor(public readonly Name: string, roles: readonly ApplicationRoleDeclaration[])
    {
        this.Roles = Object.freeze([...roles].sort((a, b) => (a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0)));
        Object.freeze(this);
    }

    /** The application a component descriptor describes: its name and its declared roles. */
    public static FromDescriptor(descriptor: IApplicationRoleSource): ApplicationDeclaration
    {
        return new ApplicationDeclaration(descriptor.Name, descriptor.Roles.map(role => new ApplicationRoleDeclaration(role.Name, role.Description)));
    }

    public Declares(role: string): boolean
    {
        return this.Roles.some(declared => declared.Name === role);
    }
}
