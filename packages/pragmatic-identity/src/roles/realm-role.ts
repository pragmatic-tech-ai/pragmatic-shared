/** Which kind of role a realm role is. */
export enum RealmRoleKind
{
    /** A predefined tenant role (running the tenant): `admin`. */
    Tenant = "tenant",
    /** A role an application declares in its component descriptor: `<application>:<role>`. */
    Application = "application",
}

/** A realm role reference that is not well formed. */
export class InvalidRealmRoleError extends Error
{
    private static readonly Template = "invalid realm role '{0}' (a tenant role 'name' or an application role 'application:name')";
    private static readonly Placeholder = "{0}";

    public constructor(public readonly Text: string)
    {
        super(InvalidRealmRoleError.Template.replace(InvalidRealmRoleError.Placeholder, Text));
        this.name = InvalidRealmRoleError.name;
    }
}

/**
 * A role the realm issues: a tenant role (`admin`) or an application role (`<application>:<role>`). Role names follow
 * the component descriptor's role names (`[a-z][A-Za-z0-9.-]*`), application names its component names
 * (`[a-z][a-z0-9-]*`), so the `:` separator is never ambiguous. Immutable.
 */
export class RealmRole
{
    public static readonly Separator = ":";
    private static readonly RoleName = /^[a-z][A-Za-z0-9.-]*$/;
    private static readonly ApplicationName = /^[a-z][a-z0-9-]*$/;
    private static readonly NoApplication = "";

    private constructor(
        public readonly Kind: RealmRoleKind,
        public readonly Application: string,
        public readonly Name: string,
    )
    {
        Object.freeze(this);
    }

    public static Tenant(name: string): RealmRole
    {
        if (!RealmRole.IsRoleName(name))
        {
            throw new InvalidRealmRoleError(name);
        }
        return new RealmRole(RealmRoleKind.Tenant, RealmRole.NoApplication, name);
    }

    public static OfApplication(application: string, name: string): RealmRole
    {
        if (!RealmRole.IsApplicationName(application) || !RealmRole.IsRoleName(name))
        {
            throw new InvalidRealmRoleError(application + RealmRole.Separator + name);
        }
        return new RealmRole(RealmRoleKind.Application, application, name);
    }

    /** `admin` is a tenant role, `ledger:finance` an application role; anything else throws InvalidRealmRoleError. */
    public static Parse(text: string): RealmRole
    {
        const role = RealmRole.TryParse(text);
        if (role === null)
        {
            throw new InvalidRealmRoleError(text);
        }
        return role;
    }

    public static TryParse(text: string): RealmRole | null
    {
        const at = text.indexOf(RealmRole.Separator);
        if (at < 0)
        {
            return RealmRole.IsRoleName(text) ? new RealmRole(RealmRoleKind.Tenant, RealmRole.NoApplication, text) : null;
        }
        const application = text.slice(0, at);
        const name = text.slice(at + 1);
        return RealmRole.IsApplicationName(application) && RealmRole.IsRoleName(name) ? new RealmRole(RealmRoleKind.Application, application, name) : null;
    }

    public static IsRoleName(name: string): boolean
    {
        return RealmRole.RoleName.test(name);
    }

    public static IsApplicationName(name: string): boolean
    {
        return RealmRole.ApplicationName.test(name);
    }

    public get IsTenantRole(): boolean
    {
        return this.Kind === RealmRoleKind.Tenant;
    }

    public Equals(other: RealmRole): boolean
    {
        return this.Kind === other.Kind && this.Application === other.Application && this.Name === other.Name;
    }

    public ToString(): string
    {
        return this.IsTenantRole ? this.Name : this.Application + RealmRole.Separator + this.Name;
    }
}
