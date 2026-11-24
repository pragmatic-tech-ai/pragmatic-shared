/** A realm secret's name and optional version, from the key a `SecretStoreDirectory` asks a store for
 *  (`<name>` or `<name>@<version>`). Names are one path segment `[a-z0-9][a-z0-9-]{0,62}`; versions are the cloud's own
 *  ids (`3`, a 32-hex Key Vault version, an AWS version UUID). */
export class RealmSecretName
{
    private static readonly NamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/
    private static readonly VersionPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
    private static readonly VersionSeparator = '@'
    private static readonly InvalidMessage = 'a realm secret name is one segment of lowercase letters, digits and "-" (at most 63)'

    private constructor(public readonly Name: string, public readonly Version: string | undefined)
    {
        Object.freeze(this)
    }

    /** The name and version of `key`, or undefined when it is not a realm secret's key (such a key is never held). */
    public static TryParse(key: string): RealmSecretName | undefined
    {
        const at = key.indexOf(RealmSecretName.VersionSeparator)
        const name = at < 0 ? key : key.slice(0, at)
        const version = at < 0 ? undefined : key.slice(at + 1)
        if (!RealmSecretName.NamePattern.test(name)) return undefined
        if (version !== undefined && !RealmSecretName.VersionPattern.test(version)) return undefined
        return new RealmSecretName(name, version)
    }

    /** A name to write (no version: a write makes the next version). Throws when it is not a realm secret's name. */
    public static ForWrite(name: string): RealmSecretName
    {
        if (!RealmSecretName.NamePattern.test(name))
        {
            throw new Error(RealmSecretName.InvalidMessage)
        }
        return new RealmSecretName(name, undefined)
    }

    public static IsName(name: string): boolean
    {
        return RealmSecretName.NamePattern.test(name)
    }
}
