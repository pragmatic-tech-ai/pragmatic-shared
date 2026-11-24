import { CanonicalJson } from '../wire/canonical-json.js'
import { ProtocolNames } from '../wire/protocol-names.js'
import { StrictFields } from '../wire/strict-fields.js'
import { SigningPublicKey, type SigningKeyPair } from '../crypto/signing-key.js'

export interface HiveKeyRotationJson
{
    HiveId: string
    PreviousKeyId: string
    NewPublicKey: string
    Proof: string
}

/**
 * A hive announcing its new identity key (`MessageKind.HiveKeyRotation`, C3.4): signed by the hive's current key (the
 * envelope), naming the key it replaces, and carrying the new public half with a proof that the sender holds its
 * private half (the new key's signature over the hive id, the previous key id and the new key id, domain-separated).
 * The platform switches the hive's key in one step and answers HiveKeyRotationAck; the agent swaps keys only then.
 */
export class HiveKeyRotation
{
    private static readonly Domain = 'pragmatic-hive-key-rotation/1\n'
    private static readonly Base64Url = 'base64url'
    private static readonly Utf8 = 'utf8'
    private static readonly ProofPattern = /^[A-Za-z0-9_-]{86}$/
    private static readonly Field = { HiveId: 'HiveId', PreviousKeyId: 'PreviousKeyId', NewPublicKey: 'NewPublicKey', Proof: 'Proof' } as const
    private static readonly Members: readonly string[] = Object.values(HiveKeyRotation.Field)

    private constructor(
        public readonly HiveId: string,
        public readonly PreviousKeyId: string,
        public readonly NewPublicKey: SigningPublicKey,
        public readonly Proof: string)
    {
    }

    /** The rotation from `previousKeyId` to `newKey` for `hiveId`, proved by the new key itself. */
    public static Create(hiveId: string, previousKeyId: string, newKey: SigningKeyPair): HiveKeyRotation
    {
        const proof = newKey.Sign(HiveKeyRotation.ProofInput(hiveId, previousKeyId, newKey.PublicKey.KeyId)).toString(HiveKeyRotation.Base64Url)
        return HiveKeyRotation.Parse({ HiveId: hiveId, PreviousKeyId: previousKeyId, NewPublicKey: newKey.PublicKey.ToJson(), Proof: proof })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): HiveKeyRotation
    {
        const F = HiveKeyRotation.Field
        const fields = StrictFields.Exactly(value, HiveKeyRotation.Members, path)
        return new HiveKeyRotation(
            fields.String(F.HiveId, { Max: 63, Pattern: ProtocolNames.Label }),
            fields.String(F.PreviousKeyId, { Max: 63, Pattern: ProtocolNames.Label }),
            fields.Read(F.NewPublicKey, (raw, at) => SigningPublicKey.Parse(raw, at)),
            fields.String(F.Proof, { Pattern: HiveKeyRotation.ProofPattern }))
    }

    /** Whether the new key signed this rotation (it holds the private half), and it is a different key. */
    public get Proven(): boolean
    {
        const R = HiveKeyRotation
        return this.NewPublicKey.KeyId !== this.PreviousKeyId
            && this.NewPublicKey.Verify(R.ProofInput(this.HiveId, this.PreviousKeyId, this.NewPublicKey.KeyId), Buffer.from(this.Proof, R.Base64Url))
    }

    public ToJson(): HiveKeyRotationJson
    {
        return { HiveId: this.HiveId, PreviousKeyId: this.PreviousKeyId, NewPublicKey: this.NewPublicKey.ToJson(), Proof: this.Proof }
    }

    private static ProofInput(hiveId: string, previousKeyId: string, newKeyId: string): Buffer
    {
        return Buffer.from(HiveKeyRotation.Domain + CanonicalJson.Stringify({ HiveId: hiveId, PreviousKeyId: previousKeyId, NewKeyId: newKeyId }), HiveKeyRotation.Utf8)
    }
}

/** The platform's acknowledgement of a hive key rotation (`MessageKind.HiveKeyRotationAck`): the hive and its key id now. */
export class HiveKeyRotationAck
{
    private static readonly Field = { HiveId: 'HiveId', KeyId: 'KeyId' } as const
    private static readonly Members: readonly string[] = Object.values(HiveKeyRotationAck.Field)

    private constructor(public readonly HiveId: string, public readonly KeyId: string)
    {
    }

    public static Create(hiveId: string, keyId: string): HiveKeyRotationAck
    {
        return HiveKeyRotationAck.Parse({ HiveId: hiveId, KeyId: keyId })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): HiveKeyRotationAck
    {
        const F = HiveKeyRotationAck.Field
        const fields = StrictFields.Exactly(value, HiveKeyRotationAck.Members, path)
        return new HiveKeyRotationAck(fields.String(F.HiveId, { Max: 63, Pattern: ProtocolNames.Label }), fields.String(F.KeyId, { Max: 63, Pattern: ProtocolNames.Label }))
    }

    public ToJson(): { HiveId: string, KeyId: string }
    {
        return { HiveId: this.HiveId, KeyId: this.KeyId }
    }
}
