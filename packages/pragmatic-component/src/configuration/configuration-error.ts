/** Why a configuration document does not fit its component descriptor. */
export enum ConfigurationErrorCode
{
    NotAnObject = 'not-an-object',
    UnknownProperty = 'unknown-property',
    UnknownOption = 'unknown-option',
    UnknownSetting = 'unknown-setting',
    MissingRequired = 'missing-required',
    WrongType = 'wrong-type',
    LiteralSecret = 'literal-secret',
    InvalidSecretReference = 'invalid-secret-reference',
}

/** One problem in a configuration document: where (a JSON pointer), what (a code) and a fixed message for the code. */
export class ConfigurationError
{
    private static readonly Messages: Readonly<Record<ConfigurationErrorCode, string>> = {
        [ConfigurationErrorCode.NotAnObject]: 'must be an object',
        [ConfigurationErrorCode.UnknownProperty]: 'is not a configuration member',
        [ConfigurationErrorCode.UnknownOption]: 'is not an option of this component version',
        [ConfigurationErrorCode.UnknownSetting]: 'is not a setting of this option',
        [ConfigurationErrorCode.MissingRequired]: 'is required',
        [ConfigurationErrorCode.WrongType]: 'is not a value of the setting type',
        [ConfigurationErrorCode.LiteralSecret]: 'is a secret setting: give a secret reference (secret:<store>/<name>[@<version>]), never the value',
        [ConfigurationErrorCode.InvalidSecretReference]: 'is not a well-formed secret reference (secret:<store>/<name>[@<version>])',
    };

    public readonly Message: string;

    public constructor(
        /** JSON pointer (RFC 6901) to the offending member; `''` is the document itself. */
        public readonly Path: string,
        public readonly Code: ConfigurationErrorCode,
    )
    {
        this.Message = ConfigurationError.Messages[Code];
        Object.freeze(this);
    }

    public toString(): string
    {
        return `${this.Path} ${this.Message}`;
    }
}
