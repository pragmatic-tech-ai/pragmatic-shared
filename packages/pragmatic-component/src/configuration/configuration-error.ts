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
    BelowMinimum = 'below-minimum',
    AboveMaximum = 'above-maximum',
}

/** One problem in a configuration document: where (a JSON pointer), what (a code) and a fixed message for the code; for a
 *  value outside a setting's bounds, the range the descriptor declares (descriptor data, never the rejected value). */
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
        [ConfigurationErrorCode.BelowMinimum]: 'is below the smallest value this setting accepts',
        [ConfigurationErrorCode.AboveMaximum]: 'is above the largest value this setting accepts',
    };

    private static readonly AcceptedOpen = ' (accepted: ';
    private static readonly AcceptedTo = ' to ';
    private static readonly AcceptedAtLeast = 'at least ';
    private static readonly AcceptedAtMost = 'at most ';
    private static readonly AcceptedClose = ')';

    public readonly Message: string;

    public constructor(
        /** JSON pointer (RFC 6901) to the offending member; `''` is the document itself. */
        public readonly Path: string,
        public readonly Code: ConfigurationErrorCode,
        /** The inclusive range the setting accepts, for a bound error (each undefined when not declared). */
        public readonly Minimum: number | undefined = undefined,
        public readonly Maximum: number | undefined = undefined,
    )
    {
        this.Message = ConfigurationError.Messages[Code] + ConfigurationError.AcceptedOf(Minimum, Maximum);
        Object.freeze(this);
    }

    private static AcceptedOf(minimum: number | undefined, maximum: number | undefined): string
    {
        const E = ConfigurationError;
        if (minimum === undefined && maximum === undefined) return '';
        const range = minimum !== undefined && maximum !== undefined ? String(minimum) + E.AcceptedTo + String(maximum)
            : minimum !== undefined ? E.AcceptedAtLeast + String(minimum) : E.AcceptedAtMost + String(maximum);
        return E.AcceptedOpen + range + E.AcceptedClose;
    }

    public toString(): string
    {
        return `${this.Path} ${this.Message}`;
    }
}
