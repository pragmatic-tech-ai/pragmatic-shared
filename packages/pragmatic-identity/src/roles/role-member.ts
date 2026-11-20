/** How a mapping names who holds a role. */
export enum RoleMemberKind
{
    /** Everyone whose sign-in through the source carries the group (a group claim value of that source). */
    SourceGroup = "source-group",
    /** One upstream user: the source and the subject it signs them in as. */
    SourceUser = "source-user",
    /** One realm account, by its id, whichever known source it signs in through. */
    Account = "account",
}

/** Who a role mapping grants the role to. Immutable; Source is empty for an Account member. */
export class RoleMember
{
    private static readonly KeySeparator = "\u0000";
    private static readonly NoSource = "";

    private constructor(
        public readonly Kind: RoleMemberKind,
        public readonly Source: string,
        public readonly Value: string,
    )
    {
        Object.freeze(this);
    }

    public static Group(source: string, group: string): RoleMember
    {
        return new RoleMember(RoleMemberKind.SourceGroup, source, group);
    }

    public static User(source: string, subject: string): RoleMember
    {
        return new RoleMember(RoleMemberKind.SourceUser, source, subject);
    }

    public static Account(accountId: string): RoleMember
    {
        return new RoleMember(RoleMemberKind.Account, RoleMember.NoSource, accountId);
    }

    /** A member from its stored parts; null when the kind is unknown. */
    public static From(kind: string, source: string, value: string): RoleMember | null
    {
        switch (kind)
        {
            case RoleMemberKind.SourceGroup:
                return RoleMember.Group(source, value);
            case RoleMemberKind.SourceUser:
                return RoleMember.User(source, value);
            case RoleMemberKind.Account:
                return source.length === 0 ? RoleMember.Account(value) : null;
            default:
                return null;
        }
    }

    /** A value is named, and a source too unless the member is an account. */
    public get IsWellFormed(): boolean
    {
        const hasSource = this.Source.length > 0;
        return this.Value.length > 0 && (this.Kind === RoleMemberKind.Account ? !hasSource : hasSource);
    }

    public Key(): string
    {
        return this.Kind + RoleMember.KeySeparator + this.Source + RoleMember.KeySeparator + this.Value;
    }

    public Equals(other: RoleMember): boolean
    {
        return this.Key() === other.Key();
    }
}
