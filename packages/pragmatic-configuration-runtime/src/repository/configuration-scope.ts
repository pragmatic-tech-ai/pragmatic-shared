import { AppliedConfigurationKeys } from '../applied/applied-configuration-keys.js';

/**
 * Whose configuration: one component (by its descriptor's component name) in one realm (the tenant's realm id). Every
 * configuration version and apply record belongs to exactly one scope.
 */
export class ConfigurationScope
{
    private static readonly RealmPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
    private static readonly ComponentPattern = /^[a-z0-9][a-z0-9-]*$/;
    private static readonly MaxComponentLength = AppliedConfigurationKeys.MaxObjectNameLength - AppliedConfigurationKeys.ObjectNamePrefix.length;
    private static readonly KeySeparator = '/';
    private static readonly InvalidRealm = 'a realm id is letters, digits, ".", "_" and "-", starting with a letter or digit';
    private static readonly InvalidComponent = 'a component name is lowercase letters, digits and "-", at most 46 characters';

    public constructor(
        public readonly Realm: string,
        public readonly Component: string,
    )
    {
        if (!ConfigurationScope.RealmPattern.test(Realm)) throw new Error(ConfigurationScope.InvalidRealm);
        if (!ConfigurationScope.ComponentPattern.test(Component) || Component.length > ConfigurationScope.MaxComponentLength)
        {
            throw new Error(ConfigurationScope.InvalidComponent);
        }
        Object.freeze(this);
    }

    public Key(): string
    {
        return this.Realm + ConfigurationScope.KeySeparator + this.Component;
    }

    public Equals(other: ConfigurationScope): boolean
    {
        return this.Realm === other.Realm && this.Component === other.Component;
    }

    public toString(): string
    {
        return this.Key();
    }
}
