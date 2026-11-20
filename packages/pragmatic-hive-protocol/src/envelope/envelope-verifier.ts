import { SigningPublicKey } from '../crypto/signing-key.js'
import { ProtocolDecodeError } from '../wire/protocol-decode-error.js'
import { MessageKind, MessageKinds, type MessageKindRule } from './message-kind.js'
import type { INonceLedger } from './nonce-ledger.js'
import type { Participant } from './participant.js'
import type { IProtocolClock } from './protocol-clock.js'
import { ProtocolVerificationError, VerificationFailure } from './protocol-verification-error.js'
import { SignedEnvelope, type IBodyDecoder } from './signed-envelope.js'

/** The public key a participant signs with: the platform's trust root, or a hive's or host's recorded key. */
export interface IKeyResolver
{
    Resolve(issuer: Participant): Promise<SigningPublicKey | undefined>
}

/** A fixed set of participant keys (a hive's trust root; tests). */
export class KeyDirectory implements IKeyResolver
{
    private readonly keys = new Map<string, SigningPublicKey>()

    public Add(participant: Participant, key: SigningPublicKey): this
    {
        this.keys.set(participant.Key, key)
        return this
    }

    public Remove(participant: Participant): void
    {
        this.keys.delete(participant.Key)
    }

    public Resolve(issuer: Participant): Promise<SigningPublicKey | undefined>
    {
        return Promise.resolve(this.keys.get(issuer.Key))
    }
}

/** A message that passed every check, with its decoded body. */
export class VerifiedMessage<T>
{
    public constructor(public readonly Envelope: SignedEnvelope, public readonly Body: T)
    {
    }

    public get Kind(): MessageKind
    {
        return this.Envelope.Kind
    }

    public get Issuer(): Participant
    {
        return this.Envelope.Issuer
    }

    public get IssuedAt(): Date
    {
        return this.Envelope.IssuedAt
    }

    public get ExpiresAt(): Date
    {
        return this.Envelope.ExpiresAt
    }

    public get Digest(): string
    {
        return this.Envelope.Digest
    }
}

export interface EnvelopeVerifierOptions
{
    /** Who this verifier receives for: the audience every accepted message must name. */
    Self: Participant
    Keys: IKeyResolver
    Nonces: INonceLedger
    Clock: IProtocolClock
}

/**
 * Accepts a message only when all hold: the expected kind; an issuer whose role may sign it; addressed to `Self`; the
 * issuer's key known (or, for a self-signed enrolment request, carried in the body and matching the issuer's id), its
 * key id named; the signature verifies; issued no later than now plus the kind's skew, not expired (skew allowed),
 * valid for no longer than the kind allows; its nonce never seen from this issuer; the body decodes strictly.
 */
export class EnvelopeVerifier
{
    private static readonly Base64Url = 'base64url'

    public constructor(private readonly options: EnvelopeVerifierOptions)
    {
    }

    public get Self(): Participant
    {
        return this.options.Self
    }

    public async Verify<T>(envelope: SignedEnvelope, kind: MessageKind, decoder: IBodyDecoder<T>): Promise<VerifiedMessage<T>>
    {
        const rule = this.CheckAddressing(envelope, kind, false)
        const key = await this.options.Keys.Resolve(envelope.Issuer)
        if (key === undefined)
        {
            throw new ProtocolVerificationError(VerificationFailure.UnknownIssuer)
        }
        this.CheckSignature(envelope, key)
        this.CheckFreshness(envelope, rule)
        const body = EnvelopeVerifier.DecodeBody(envelope, decoder)
        await this.ClaimNonce(envelope, rule)
        return new VerifiedMessage(envelope, body)
    }

    /**
     * An enrolment request: the issuer is not known yet, so the key comes from the body (`keyOf`) and the issuer's id
     * must be that key's id. Proves the sender holds the private half of the key it enrols.
     */
    public async VerifySelfSigned<T>(envelope: SignedEnvelope, kind: MessageKind, decoder: IBodyDecoder<T>, keyOf: (body: T) => SigningPublicKey): Promise<VerifiedMessage<T>>
    {
        const rule = this.CheckAddressing(envelope, kind, true)
        const body = EnvelopeVerifier.DecodeBody(envelope, decoder)
        const key = keyOf(body)
        if (envelope.Issuer.Id !== key.KeyId)
        {
            throw new ProtocolVerificationError(VerificationFailure.KeyMismatch)
        }
        this.CheckSignature(envelope, key)
        this.CheckFreshness(envelope, rule)
        await this.ClaimNonce(envelope, rule)
        return new VerifiedMessage(envelope, body)
    }

    /**
     * A standing message kept since it was verified (an intent waiting for approval): every check again except the
     * nonce, which its first verification claimed.
     */
    public async Recheck<T>(envelope: SignedEnvelope, kind: MessageKind, decoder: IBodyDecoder<T>): Promise<VerifiedMessage<T>>
    {
        const rule = this.CheckAddressing(envelope, kind, false)
        const key = await this.options.Keys.Resolve(envelope.Issuer)
        if (key === undefined)
        {
            throw new ProtocolVerificationError(VerificationFailure.UnknownIssuer)
        }
        this.CheckSignature(envelope, key)
        this.CheckFreshness(envelope, rule)
        return new VerifiedMessage(envelope, EnvelopeVerifier.DecodeBody(envelope, decoder))
    }

    private CheckAddressing(envelope: SignedEnvelope, kind: MessageKind, selfSigned: boolean): MessageKindRule
    {
        const rule = MessageKinds.Rule(kind)
        if (envelope.Kind !== kind || rule.SelfSigned !== selfSigned)
        {
            throw new ProtocolVerificationError(VerificationFailure.WrongKind)
        }
        if (!rule.Issuers.includes(envelope.Issuer.Role))
        {
            throw new ProtocolVerificationError(VerificationFailure.WrongIssuer)
        }
        if (!envelope.Audience.Equals(this.options.Self))
        {
            throw new ProtocolVerificationError(VerificationFailure.WrongAudience)
        }
        return rule
    }

    private CheckSignature(envelope: SignedEnvelope, key: SigningPublicKey): void
    {
        if (envelope.KeyId !== key.KeyId)
        {
            throw new ProtocolVerificationError(VerificationFailure.KeyMismatch)
        }
        if (!key.Verify(envelope.SigningInput(), Buffer.from(envelope.Signature, EnvelopeVerifier.Base64Url)))
        {
            throw new ProtocolVerificationError(VerificationFailure.BadSignature)
        }
    }

    private CheckFreshness(envelope: SignedEnvelope, rule: MessageKindRule): void
    {
        const now = this.options.Clock.Now().getTime()
        const policy = rule.Freshness
        if (envelope.IssuedAt.getTime() > now + policy.MaxSkewMs)
        {
            throw new ProtocolVerificationError(VerificationFailure.NotYetValid)
        }
        if (envelope.ExpiresAt.getTime() + policy.MaxSkewMs < now)
        {
            throw new ProtocolVerificationError(VerificationFailure.Expired)
        }
        if (envelope.ExpiresAt.getTime() - envelope.IssuedAt.getTime() > policy.MaxLifetimeMs)
        {
            throw new ProtocolVerificationError(VerificationFailure.LifetimeTooLong)
        }
    }

    private async ClaimNonce(envelope: SignedEnvelope, rule: MessageKindRule): Promise<void>
    {
        const keepUntil = new Date(envelope.ExpiresAt.getTime() + rule.Freshness.MaxSkewMs)
        if (!await this.options.Nonces.Claim(envelope.Issuer, envelope.Nonce, keepUntil))
        {
            throw new ProtocolVerificationError(VerificationFailure.Replayed)
        }
    }

    private static DecodeBody<T>(envelope: SignedEnvelope, decoder: IBodyDecoder<T>): T
    {
        try
        {
            return decoder.Parse(envelope.Body, SignedEnvelope.BodyPath)
        }
        catch (error)
        {
            if (error instanceof ProtocolDecodeError)
            {
                throw new ProtocolVerificationError(VerificationFailure.Malformed, error)
            }
            throw error
        }
    }
}
