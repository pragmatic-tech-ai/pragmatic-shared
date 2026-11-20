import type { ProtocolDecodeError } from '../wire/protocol-decode-error.js'

/** Why a message was not accepted: fixed sentences, safe to log and to answer with. */
export enum VerificationFailure
{
    Malformed = 'The message is not in the protocol shape.',
    WrongKind = 'The message is not the kind expected here.',
    WrongIssuer = 'The message kind may not be signed by this issuer.',
    WrongAudience = 'The message is addressed to someone else.',
    UnknownIssuer = 'The issuer is not known.',
    KeyMismatch = 'The message names another key than the issuer\'s.',
    BadSignature = 'The signature does not verify.',
    NotYetValid = 'The message is issued in the future.',
    Expired = 'The message has expired.',
    LifetimeTooLong = 'The message is valid for longer than its kind allows.',
    Replayed = 'The message was already received.',
}

/** A message refused by a verifier. `Decode` holds the shape error when the failure is Malformed. */
export class ProtocolVerificationError extends Error
{
    private static readonly ErrorName = 'ProtocolVerificationError'

    public constructor(public readonly Failure: VerificationFailure, public readonly Decode: ProtocolDecodeError | null = null)
    {
        super(Failure)
        this.name = ProtocolVerificationError.ErrorName
    }
}
