import type { ResolvedConfiguration, SettingValue } from '@pragmatic-tech-ai/pragmatic-component';
import type { SecretValue } from './secret-value.js';

/**
 * The configuration a component runs on: the applied version it came from, the validated settings (descriptor order,
 * defaults filled in) and the resolved secrets. `Value` gives a secret setting's reference; `Secret` its value, as a
 * `SecretValue` that never prints itself.
 */
export class RuntimeConfiguration
{
    private static readonly KeySeparator = '/';
    private readonly secrets: ReadonlyMap<string, SecretValue>;

    public constructor(
        public readonly Version: number,
        public readonly ComponentVersion: string,
        public readonly DescriptorDigest: string,
        public readonly Settings: ResolvedConfiguration,
        secrets: ReadonlyMap<string, SecretValue>,
    )
    {
        this.secrets = new Map(secrets);
        Object.freeze(this);
    }

    public static SecretKey(option: string, setting: string): string
    {
        return option + RuntimeConfiguration.KeySeparator + setting;
    }

    public IsEnabled(option: string): boolean
    {
        return this.Settings.IsEnabled(option);
    }

    /** The given or default value (a `SecretReference` for a secret setting); undefined when unset or not enabled. */
    public Value(option: string, setting: string): SettingValue | undefined
    {
        return this.Settings.Value(option, setting);
    }

    /** The resolved secret of a secret setting; undefined for a setting that is not secret, unset or not enabled. */
    public Secret(option: string, setting: string): SecretValue | undefined
    {
        return this.secrets.get(RuntimeConfiguration.SecretKey(option, setting));
    }
}
