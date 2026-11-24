import { RealmSecretsOption, RealmSecretsOptions } from './realm-secrets-option.js'

/** One setting a realm option's secrets home takes: an identifier (never a key), with the form it must have. */
export class RealmSecretsSettingRule
{
    public constructor(
        public readonly Name: string,
        public readonly Pattern: RegExp,
        public readonly Required: boolean,
        /** What the setting is, for errors and documentation. */
        public readonly Description: string)
    {
        Object.freeze(this)
    }

    /** The environment variable the setting is read from: `PRAGMATIC_REALM_SECRETS_<NAME IN UPPER SNAKE CASE>`. */
    public get Variable(): string
    {
        return RealmSecretsSettings.VariableOf(this.Name)
    }
}

/** A realm secrets home's settings are refused. The message names settings, never a value. */
export class RealmSecretsSettingsError extends Error
{
    public static readonly ErrorName = 'RealmSecretsSettingsError'

    public constructor(message: string)
    {
        super(message)
        this.name = RealmSecretsSettingsError.ErrorName
    }
}

/**
 * Which secrets home a realm has and the option's non-secret identifiers (project, vault URL, region, role ARN, client
 * id). They are installation facts every component of the hive shares, rendered by the engine chart into each
 * component's environment (`PRAGMATIC_REALM_SECRETS_OPTION` and `PRAGMATIC_REALM_SECRETS_<SETTING>`), so the home is
 * known before any secret reference of a configuration resolves. Validated against the option's rules
 * (`Validated`): an unknown setting is refused, and for a cloud option one named like a credential (a key file, a client
 * secret, an access key) is refused as key-shaped, since a hive reaches a cloud by workload identity only.
 */
export class RealmSecretsSettings
{
    public static readonly OptionVariable = 'PRAGMATIC_REALM_SECRETS_OPTION'
    private static readonly VariablePrefix = 'PRAGMATIC_REALM_SECRETS_'
    private static readonly WordBoundary = /([a-z0-9])([A-Z])/g
    private static readonly WordJoin = '$1_$2'
    private static readonly VariableTail = /^[A-Z0-9]+(_[A-Z0-9]+)*$/
    /** Setting names, values or variables that look like a credential rather than an identifier. */
    private static readonly KeyShapedName = /secret|password|passphrase|credential|private|accesskey|access_key|apikey|api_key|keyfile|key_file|token|certificate|key$/i
    private static readonly KeyShapedValues: readonly RegExp[] = [/-----BEGIN /, /"private_key"/, /"type"\s*:\s*"service_account"/, /^(AKIA|ASIA)[A-Z0-9]{16}$/]
    private static readonly UnknownOption = 'the realm secrets option must be one of custom, gcp, azure, aws; got another value in '
    private static readonly KeyShaped = ' is refused: a realm secrets home takes identifiers only, never a key or secret (workload identity supplies the credentials)'
    private static readonly KeyShapedValue = ' holds a key-shaped value; a realm secrets home takes identifiers only'
    private static readonly Unknown = ' is not a setting of the realm secrets option '
    private static readonly Missing = ' is required by the realm secrets option '
    private static readonly Malformed = ' does not have the form of '
    private static readonly SettingWord = 'the setting '

    private constructor(public readonly Option: RealmSecretsOption, private readonly values: ReadonlyMap<string, string>)
    {
        Object.freeze(this)
    }

    public static Of(option: RealmSecretsOption, values: Readonly<Record<string, string | undefined>>): RealmSecretsSettings
    {
        const map = new Map<string, string>()
        for (const [name, value] of Object.entries(values))
        {
            if (value !== undefined && value !== '') map.set(name, value)
        }
        return new RealmSecretsSettings(option, map)
    }

    /** The settings the environment carries, or undefined when it names no realm secrets option (the hive has no
     *  realm secrets home yet: its components keep their own stores). */
    public static FromEnvironment(env: Readonly<Record<string, string | undefined>>): RealmSecretsSettings | undefined
    {
        const S = RealmSecretsSettings
        const text = env[S.OptionVariable]
        if (text === undefined || text === '') return undefined
        const option = RealmSecretsOptions.Parse(text)
        if (option === undefined) throw new RealmSecretsSettingsError(S.UnknownOption + S.OptionVariable)
        const values = new Map<string, string>()
        for (const [variable, value] of Object.entries(env))
        {
            if (!variable.startsWith(S.VariablePrefix) || variable === S.OptionVariable || value === undefined || value === '') continue
            const tail = variable.slice(S.VariablePrefix.length)
            if (!S.VariableTail.test(tail)) throw new RealmSecretsSettingsError(S.SettingWord + variable + S.Unknown + option)
            values.set(S.NameOf(tail), value)
        }
        return new RealmSecretsSettings(option, values)
    }

    /** `projectId` → `PRAGMATIC_REALM_SECRETS_PROJECT_ID`. */
    public static VariableOf(name: string): string
    {
        return RealmSecretsSettings.VariablePrefix + name.replace(RealmSecretsSettings.WordBoundary, RealmSecretsSettings.WordJoin).toUpperCase()
    }

    public Get(name: string): string | undefined
    {
        return this.values.get(name)
    }

    public get Names(): readonly string[]
    {
        return [...this.values.keys()].sort()
    }

    /** These settings checked against the option's rules; throws RealmSecretsSettingsError naming the first fault. */
    public Validated(rules: readonly RealmSecretsSettingRule[]): RealmSecretsSettings
    {
        const S = RealmSecretsSettings
        const cloud = this.Option !== RealmSecretsOption.Custom
        const known = new Map(rules.map(rule => [rule.Name, rule]))
        for (const [name, value] of this.values)
        {
            const rule = known.get(name)
            if (rule === undefined)
            {
                if (cloud && S.KeyShapedName.test(name)) throw new RealmSecretsSettingsError(S.SettingWord + S.VariableOf(name) + S.KeyShaped)
                throw new RealmSecretsSettingsError(S.SettingWord + S.VariableOf(name) + S.Unknown + this.Option)
            }
            if (cloud && S.KeyShapedValues.some(pattern => pattern.test(value))) throw new RealmSecretsSettingsError(S.SettingWord + rule.Variable + S.KeyShapedValue)
            if (!rule.Pattern.test(value)) throw new RealmSecretsSettingsError(S.SettingWord + rule.Variable + S.Malformed + rule.Description)
        }
        for (const rule of rules)
        {
            if (rule.Required && !this.values.has(rule.Name)) throw new RealmSecretsSettingsError(S.SettingWord + rule.Variable + S.Missing + this.Option)
        }
        return this
    }

    // `PROJECT_ID` → `projectId`.
    private static NameOf(tail: string): string
    {
        const words = tail.toLowerCase().split('_')
        return words[0] + words.slice(1).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('')
    }
}
