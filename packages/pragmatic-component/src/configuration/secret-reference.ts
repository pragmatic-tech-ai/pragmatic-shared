/**
 * A reference into the realm's secrets home: the store that holds the secret, the secret's name in it and optionally a
 * pinned version. A configuration never holds a secret value, only this reference, written `secret:<store>/<name>[@<version>]`.
 */
export class SecretReference
{
    public static readonly Scheme = 'secret:';
    public static readonly Pattern = '^secret:[a-z0-9][a-z0-9-]*/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*(@[A-Za-z0-9._-]+)?$';

    private static readonly StorePattern = /^[a-z0-9][a-z0-9-]*$/;
    private static readonly NamePattern = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
    private static readonly VersionPattern = /^[A-Za-z0-9._-]+$/;
    private static readonly FullPattern = new RegExp(SecretReference.Pattern);
    private static readonly StoreSeparator = '/';
    private static readonly VersionSeparator = '@';
    private static readonly InvalidStore = 'invalid secret reference store';
    private static readonly InvalidName = 'invalid secret reference name';
    private static readonly InvalidVersion = 'invalid secret reference version';
    private static readonly Malformed = 'malformed secret reference (expected secret:<store>/<name>[@<version>])';

    public constructor(
        public readonly Store: string,
        public readonly Name: string,
        public readonly Version?: string,
    )
    {
        if (!SecretReference.StorePattern.test(Store)) throw new Error(`${SecretReference.InvalidStore}: '${Store}'`);
        if (!SecretReference.NamePattern.test(Name)) throw new Error(`${SecretReference.InvalidName}: '${Name}'`);
        if (Version !== undefined && !SecretReference.VersionPattern.test(Version))
        {
            throw new Error(`${SecretReference.InvalidVersion}: '${Version}'`);
        }
        Object.freeze(this);
    }

    /** True when the text is written in the reference form (it may still be malformed). */
    public static LooksLikeReference(text: string): boolean
    {
        return text.startsWith(SecretReference.Scheme);
    }

    public static Parse(text: string): SecretReference
    {
        const reference = SecretReference.TryParse(text);
        if (reference === undefined) throw new Error(`${SecretReference.Malformed}: '${text}'`);
        return reference;
    }

    public static TryParse(text: string): SecretReference | undefined
    {
        if (!SecretReference.FullPattern.test(text)) return undefined;
        const body = text.slice(SecretReference.Scheme.length);
        const storeEnd = body.indexOf(SecretReference.StoreSeparator);
        const versionStart = body.indexOf(SecretReference.VersionSeparator);
        const store = body.slice(0, storeEnd);
        const name = versionStart < 0 ? body.slice(storeEnd + 1) : body.slice(storeEnd + 1, versionStart);
        const version = versionStart < 0 ? undefined : body.slice(versionStart + 1);
        return new SecretReference(store, name, version);
    }

    public Format(): string
    {
        const head = `${SecretReference.Scheme}${this.Store}${SecretReference.StoreSeparator}${this.Name}`;
        return this.Version === undefined ? head : `${head}${SecretReference.VersionSeparator}${this.Version}`;
    }

    public Equals(other: SecretReference): boolean
    {
        return this.Store === other.Store && this.Name === other.Name && this.Version === other.Version;
    }

    public toString(): string
    {
        return this.Format();
    }
}
