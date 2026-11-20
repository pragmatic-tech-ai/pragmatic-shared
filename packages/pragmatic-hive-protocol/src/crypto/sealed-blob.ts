import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { StrictFields } from '../wire/strict-fields.js'
import { SealingKeyPair, SealingPublicKey } from './sealing-key.js'
import { KeyEncoding } from './key-encoding.js'

/** The one sealing scheme: ephemeral X25519 agreement, HKDF-SHA256, AES-256-GCM. */
export enum SealingAlgorithm
{
    X25519HkdfSha256Aes256Gcm = 'x25519-hkdf-sha256-aes-256-gcm',
}

/** A blob that does not open: another recipient, another context, or altered bytes. Says nothing more. */
export class SealedBlobError extends Error
{
    private static readonly ErrorName = 'SealedBlobError'
    private static readonly Text = 'The sealed blob could not be opened.'

    public constructor()
    {
        super(SealedBlobError.Text)
        this.name = SealedBlobError.ErrorName
    }
}

export interface SealedBlobJson
{
    Algorithm: SealingAlgorithm
    RecipientKeyId: string
    EphemeralKey: string
    Nonce: string
    Ciphertext: string
    Tag: string
}

/**
 * Bytes sealed for one recipient's X25519 key (the platform's sealing key): only the holder of its private half opens
 * them. The context (the canonical JSON of the message members around the blob) is authenticated, so a blob cut out of
 * one message and pasted into another does not open. The sender keeps no key: a fresh ephemeral pair per blob.
 */
export class SealedBlob
{
    public static readonly MaxPlaintextBytes = 65536
    private static readonly Base64Url = 'base64url'
    private static readonly Cipher = 'aes-256-gcm'
    private static readonly Hash = 'sha256'
    private static readonly Info = 'pragmatic-hive-protocol/sealed-blob/1'
    private static readonly KeyBytes = 32
    private static readonly NonceBytes = 12
    private static readonly TagBytes = 16
    private static readonly NoncePattern = /^[A-Za-z0-9_-]{16}$/
    private static readonly TagPattern = /^[A-Za-z0-9_-]{22}$/
    private static readonly CiphertextPattern = /^[A-Za-z0-9_-]+$/
    private static readonly MaxCiphertextChars = 87382
    private static readonly Algorithms: readonly SealingAlgorithm[] = Object.values(SealingAlgorithm)
    private static readonly Field = { Algorithm: 'Algorithm', RecipientKeyId: 'RecipientKeyId', EphemeralKey: 'EphemeralKey', Nonce: 'Nonce', Ciphertext: 'Ciphertext', Tag: 'Tag' } as const
    private static readonly Members: readonly string[] = Object.values(SealedBlob.Field)

    private constructor(
        public readonly Algorithm: SealingAlgorithm,
        public readonly RecipientKeyId: string,
        public readonly EphemeralKey: SealingPublicKey,
        private readonly nonce: Buffer,
        private readonly ciphertext: Buffer,
        private readonly tag: Buffer)
    {
    }

    public static Seal(plaintext: Buffer, recipient: SealingPublicKey, context: Buffer): SealedBlob
    {
        const S = SealedBlob
        if (plaintext.length === 0 || plaintext.length > S.MaxPlaintextBytes)
        {
            throw new SealedBlobError()
        }
        const ephemeral = SealingKeyPair.Generate()
        const key = S.DeriveKey(ephemeral.Agree(recipient), ephemeral.PublicKey, recipient)
        const nonce = randomBytes(S.NonceBytes)
        const cipher = createCipheriv(S.Cipher, key, nonce, { authTagLength: S.TagBytes })
        cipher.setAAD(context)
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
        return new SealedBlob(SealingAlgorithm.X25519HkdfSha256Aes256Gcm, recipient.KeyId, ephemeral.PublicKey, nonce, ciphertext, cipher.getAuthTag())
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): SealedBlob
    {
        const S = SealedBlob
        const F = S.Field
        const fields = StrictFields.Exactly(value, S.Members, path)
        const algorithm = fields.Enum(F.Algorithm, S.Algorithms)
        const recipient = fields.String(F.RecipientKeyId, { Pattern: KeyEncoding.KeyIdPattern })
        const ephemeral = fields.Read(F.EphemeralKey, (raw, at) => SealingPublicKey.Parse(raw, at))
        const nonce = fields.String(F.Nonce, { Pattern: S.NoncePattern })
        const ciphertext = fields.String(F.Ciphertext, { Max: S.MaxCiphertextChars, Pattern: S.CiphertextPattern })
        const tag = fields.String(F.Tag, { Pattern: S.TagPattern })
        return new SealedBlob(algorithm, recipient, ephemeral, Buffer.from(nonce, S.Base64Url), Buffer.from(ciphertext, S.Base64Url), Buffer.from(tag, S.Base64Url))
    }

    /** The plaintext, for the recipient pair under the same context; a SealedBlobError otherwise. */
    public Open(recipient: SealingKeyPair, context: Buffer): Buffer
    {
        const S = SealedBlob
        if (recipient.PublicKey.KeyId !== this.RecipientKeyId)
        {
            throw new SealedBlobError()
        }
        try
        {
            const key = S.DeriveKey(recipient.Agree(this.EphemeralKey), this.EphemeralKey, recipient.PublicKey)
            const decipher = createDecipheriv(S.Cipher, key, this.nonce, { authTagLength: S.TagBytes })
            decipher.setAAD(context)
            decipher.setAuthTag(this.tag)
            return Buffer.concat([decipher.update(this.ciphertext), decipher.final()])
        }
        catch
        {
            throw new SealedBlobError()
        }
    }

    public ToJson(): SealedBlobJson
    {
        const S = SealedBlob
        return {
            Algorithm: this.Algorithm,
            RecipientKeyId: this.RecipientKeyId,
            EphemeralKey: this.EphemeralKey.ToJson(),
            Nonce: this.nonce.toString(S.Base64Url),
            Ciphertext: this.ciphertext.toString(S.Base64Url),
            Tag: this.tag.toString(S.Base64Url),
        }
    }

    private static DeriveKey(shared: Buffer, ephemeral: SealingPublicKey, recipient: SealingPublicKey): Buffer
    {
        const S = SealedBlob
        if (shared.every(octet => octet === 0))
        {
            throw new SealedBlobError()
        }
        const salt = Buffer.concat([Buffer.from(ephemeral.Raw, S.Base64Url), Buffer.from(recipient.Raw, S.Base64Url)])
        return Buffer.from(hkdfSync(S.Hash, shared, salt, S.Info, S.KeyBytes))
    }
}
