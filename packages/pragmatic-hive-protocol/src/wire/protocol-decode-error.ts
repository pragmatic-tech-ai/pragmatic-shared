/** Why a member was refused: fixed sentences, never the refused value. */
export enum DecodeReason
{
    NotObject = 'must be a JSON object',
    Missing = 'is required',
    Unknown = 'is not a known member',
    NotString = 'must be a string',
    BadLength = 'has a length out of range',
    BadFormat = 'is not in the expected format',
    NotInteger = 'must be an integer',
    OutOfRange = 'is out of range',
    NotBoolean = 'must be true or false',
    NotAllowed = 'is not one of the allowed values',
    NotArray = 'must be an array',
    TooMany = 'has too many entries',
    Duplicate = 'lists the same entry twice',
    NotTimestamp = 'must be a UTC timestamp',
    NotJson = 'is not JSON',
    TooLarge = 'is too large',
    Inconsistent = 'does not match the other members',
    NotCanonical = 'holds a value the protocol cannot carry',
}

/**
 * A message that is not exactly the protocol's shape: a missing or unknown member, a value of the wrong type, length,
 * format or range. The message names the member's path and a fixed reason, never the value, so a refusal can be
 * logged without carrying what a sender put in it.
 */
export class ProtocolDecodeError extends Error
{
    private static readonly ErrorName = 'ProtocolDecodeError'
    private static readonly Separator = ': '

    public constructor(public readonly Path: string, public readonly Reason: DecodeReason)
    {
        super(Path + ProtocolDecodeError.Separator + Reason)
        this.name = ProtocolDecodeError.ErrorName
    }
}
