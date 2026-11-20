import { randomBytes } from 'node:crypto'
import type { SigningKeyPair } from '../crypto/signing-key.js'
import { MessageKind, MessageKinds } from './message-kind.js'
import { Participant, ParticipantRole } from './participant.js'
import type { IProtocolClock } from './protocol-clock.js'
import { SignedEnvelope, type IMessageBody } from './signed-envelope.js'

/** A message its signer may not send: a kind not signed by this role, to an audience it is not for, or for too long. */
export class EnvelopeSigningError extends Error
{
    private static readonly ErrorName = 'EnvelopeSigningError'

    public constructor(message: string)
    {
        super(message)
        this.name = EnvelopeSigningError.ErrorName
    }
}

/**
 * Signs messages as one participant with its key pair: fresh nonce (16 random bytes), issued now, expiring after the
 * kind's default lifetime or the one asked (never beyond the kind's maximum).
 */
export class EnvelopeSigner
{
    private static readonly NonceBytes = 16
    private static readonly Base64Url = 'base64url'
    private static readonly WrongIssuerText = 'This participant may not sign this kind of message.'
    private static readonly WrongAudienceText = 'This kind of message is not addressed to that participant.'
    private static readonly LifetimeText = 'The lifetime is out of range for this kind of message.'

    public constructor(private readonly key: SigningKeyPair, public readonly Issuer: Participant, private readonly clock: IProtocolClock)
    {
    }

    /** An agent before enrolment: its id is its key id. */
    public static SelfSigned(key: SigningKeyPair, role: ParticipantRole.Hive | ParticipantRole.Host, clock: IProtocolClock): EnvelopeSigner
    {
        return new EnvelopeSigner(key, Participant.Of(role, key.KeyId), clock)
    }

    public get KeyId(): string
    {
        return this.key.KeyId
    }

    public Sign(kind: MessageKind, audience: Participant, body: IMessageBody, lifetimeMs?: number): SignedEnvelope
    {
        const E = EnvelopeSigner
        const rule = MessageKinds.Rule(kind)
        if (!rule.Issuers.includes(this.Issuer.Role))
        {
            throw new EnvelopeSigningError(E.WrongIssuerText)
        }
        if (!rule.Audiences.includes(audience.Role))
        {
            throw new EnvelopeSigningError(E.WrongAudienceText)
        }
        const lifetime = lifetimeMs ?? rule.Freshness.DefaultLifetimeMs
        if (!Number.isSafeInteger(lifetime) || lifetime <= 0 || lifetime > rule.Freshness.MaxLifetimeMs)
        {
            throw new EnvelopeSigningError(E.LifetimeText)
        }
        const issuedAt = this.clock.Now()
        const unsigned = {
            Protocol: SignedEnvelope.Protocol,
            Kind: kind,
            Issuer: this.Issuer.ToJson(),
            Audience: audience.ToJson(),
            KeyId: this.key.KeyId,
            IssuedAt: issuedAt.toISOString(),
            ExpiresAt: new Date(issuedAt.getTime() + lifetime).toISOString(),
            Nonce: randomBytes(E.NonceBytes).toString(E.Base64Url),
            Body: body.ToJson() as Record<string, unknown>,
        }
        const signature = this.key.Sign(SignedEnvelope.SigningInput(unsigned)).toString(E.Base64Url)
        return SignedEnvelope.Parse({ ...unsigned, Signature: signature })
    }
}
