import { CanonicalJson } from '../wire/canonical-json.js'
import { DecodeReason } from '../wire/protocol-decode-error.js'
import { ProtocolJson } from '../wire/protocol-json.js'
import { ProtocolNames } from '../wire/protocol-names.js'
import { StrictFields } from '../wire/strict-fields.js'
import { KeyEncoding } from '../crypto/key-encoding.js'
import { MessageKind, MessageKinds } from './message-kind.js'
import { Participant, type ParticipantJson } from './participant.js'

/** The wire form of an envelope (protocol 1). */
export interface SignedEnvelopeJson
{
    Protocol: number
    Kind: MessageKind
    Issuer: ParticipantJson
    Audience: ParticipantJson
    KeyId: string
    IssuedAt: string
    ExpiresAt: string
    Nonce: string
    Body: Record<string, unknown>
    Signature: string
}

/** A body: a closed shape that writes itself as plain JSON. */
export interface IMessageBody
{
    ToJson(): object
}

/** A body's strict decoder (each message class's static Parse). */
export interface IBodyDecoder<T>
{
    Parse(value: unknown, path: string): T
}

/**
 * One signed message: kind, issuer, audience, the issuer's key id, issued-at, expires-at, a random nonce, the body,
 * and an Ed25519 signature over the canonical JSON of everything but the signature, prefixed with the protocol's
 * domain string (so no signature made for anything else can verify here). Decoding is strict but checks no
 * signature; `EnvelopeVerifier` does that and decodes the body.
 */
export class SignedEnvelope
{
    public static readonly Protocol = 1
    /** The largest message text accepted (a pull batch of intents is the largest message). */
    public static readonly MaxBytes = 1_048_576
    public static readonly BodyPath = StrictFields.Root + '.Body'
    private static readonly Domain = 'pragmatic-hive-protocol/1\n'
    private static readonly Utf8 = 'utf8'
    private static readonly SignaturePattern = /^[A-Za-z0-9_-]{86}$/
    private static readonly Field = { Protocol: 'Protocol', Kind: 'Kind', Issuer: 'Issuer', Audience: 'Audience', KeyId: 'KeyId', IssuedAt: 'IssuedAt', ExpiresAt: 'ExpiresAt', Nonce: 'Nonce', Body: 'Body', Signature: 'Signature' } as const
    private static readonly Members: readonly string[] = Object.values(SignedEnvelope.Field)

    public constructor(
        public readonly Kind: MessageKind,
        public readonly Issuer: Participant,
        public readonly Audience: Participant,
        public readonly KeyId: string,
        public readonly IssuedAt: Date,
        public readonly ExpiresAt: Date,
        public readonly Nonce: string,
        public readonly Body: Readonly<Record<string, unknown>>,
        public readonly Signature: string)
    {
    }

    /** Text off the wire: size limit, JSON, then Parse. */
    public static Decode(text: string, maxBytes: number = SignedEnvelope.MaxBytes): SignedEnvelope
    {
        return SignedEnvelope.Parse(ProtocolJson.Parse(text, maxBytes))
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): SignedEnvelope
    {
        const S = SignedEnvelope
        const F = S.Field
        const fields = StrictFields.Exactly(value, S.Members, path)
        fields.Integer(F.Protocol, { Min: S.Protocol, Max: S.Protocol })
        const kind = fields.Enum(F.Kind, MessageKinds.All)
        const issuer = fields.Read(F.Issuer, (raw, at) => Participant.Parse(raw, at))
        const audience = fields.Read(F.Audience, (raw, at) => Participant.Parse(raw, at))
        const keyId = fields.String(F.KeyId, { Pattern: KeyEncoding.KeyIdPattern })
        const issuedAt = fields.Timestamp(F.IssuedAt)
        const expiresAt = fields.Timestamp(F.ExpiresAt)
        const nonce = fields.String(F.Nonce, { Pattern: ProtocolNames.Nonce })
        const body = fields.Raw(F.Body)
        if (!StrictFields.IsObject(body))
        {
            throw fields.Refuse(F.Body, DecodeReason.NotObject)
        }
        let copy: Record<string, unknown>
        try
        {
            copy = JSON.parse(CanonicalJson.Stringify(body)) as Record<string, unknown>
        }
        catch
        {
            throw fields.Refuse(F.Body, DecodeReason.NotCanonical)
        }
        const signature = fields.String(F.Signature, { Pattern: S.SignaturePattern })
        if (expiresAt.getTime() <= issuedAt.getTime())
        {
            throw fields.Refuse(F.ExpiresAt, DecodeReason.Inconsistent)
        }
        return new SignedEnvelope(kind, issuer, audience, keyId, issuedAt, expiresAt, nonce, copy, signature)
    }

    /** The bytes the signature covers. */
    public static SigningInput(unsigned: Omit<SignedEnvelopeJson, 'Signature'>): Buffer
    {
        return Buffer.concat([Buffer.from(SignedEnvelope.Domain, SignedEnvelope.Utf8), CanonicalJson.Bytes(unsigned)])
    }

    public SigningInput(): Buffer
    {
        const { Signature: _signature, ...unsigned } = this.ToJson()
        return SignedEnvelope.SigningInput(unsigned)
    }

    /** `sha256:` of the whole signed envelope's canonical JSON: names this exact message (an approval binds to it). */
    public get Digest(): string
    {
        return CanonicalJson.Digest(this.ToJson())
    }

    public ToJson(): SignedEnvelopeJson
    {
        return {
            Protocol: SignedEnvelope.Protocol,
            Kind: this.Kind,
            Issuer: this.Issuer.ToJson(),
            Audience: this.Audience.ToJson(),
            KeyId: this.KeyId,
            IssuedAt: this.IssuedAt.toISOString(),
            ExpiresAt: this.ExpiresAt.toISOString(),
            Nonce: this.Nonce,
            Body: JSON.parse(CanonicalJson.Stringify(this.Body)) as Record<string, unknown>,
            Signature: this.Signature,
        }
    }

    /** The wire text (canonical JSON). */
    public Encode(): string
    {
        return CanonicalJson.Stringify(this.ToJson())
    }
}
