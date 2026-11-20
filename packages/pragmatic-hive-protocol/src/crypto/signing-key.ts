import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { inspect } from 'node:util'
import { DecodeReason, ProtocolDecodeError } from '../wire/protocol-decode-error.js'
import { CurveKeyType, KeyEncoding } from './key-encoding.js'

/** A key that is not an Ed25519 key, or a PEM that is not one. */
export class SigningKeyError extends Error
{
    private static readonly ErrorName = 'SigningKeyError'
    private static readonly Text = 'The key is not an Ed25519 key.'

    public constructor()
    {
        super(SigningKeyError.Text)
        this.name = SigningKeyError.ErrorName
    }
}

/** The public half of an Ed25519 signing key: the platform's trust root, a hive's or a host's identity. */
export class SigningPublicKey
{
    private static readonly Path = 'key'
    private static readonly Pem = 'pem'
    private static readonly Spki = 'spki'

    private constructor(private readonly key: KeyObject, public readonly Raw: string)
    {
    }

    /** The wire form: raw 32 bytes, base64url. */
    public static Parse(value: unknown, path: string = SigningPublicKey.Path): SigningPublicKey
    {
        if (typeof value !== 'string')
        {
            throw new ProtocolDecodeError(path, DecodeReason.NotString)
        }
        return new SigningPublicKey(KeyEncoding.Import(value, CurveKeyType.Ed25519, path), value)
    }

    /** An SPKI PEM, as the platform's key store keeps its signing key's public half. */
    public static FromPem(pem: string): SigningPublicKey
    {
        let key: KeyObject
        try
        {
            key = createPublicKey(pem)
        }
        catch
        {
            throw new SigningKeyError()
        }
        return SigningPublicKey.FromKeyObject(key)
    }

    public static FromKeyObject(key: KeyObject): SigningPublicKey
    {
        if (!KeyEncoding.IsType(key, CurveKeyType.Ed25519))
        {
            throw new SigningKeyError()
        }
        return new SigningPublicKey(key, KeyEncoding.Raw(key))
    }

    public get KeyId(): string
    {
        return KeyEncoding.KeyId(this.Raw, CurveKeyType.Ed25519)
    }

    public Verify(data: Buffer, signature: Buffer): boolean
    {
        try
        {
            return verify(null, data, this.key, signature)
        }
        catch
        {
            return false
        }
    }

    public Equals(other: SigningPublicKey): boolean
    {
        return this.Raw === other.Raw
    }

    public ToPem(): string
    {
        return this.key.export({ format: SigningPublicKey.Pem, type: SigningPublicKey.Spki }) as string
    }

    public ToJson(): string
    {
        return this.Raw
    }
}

/**
 * An Ed25519 key pair. A hive's pair is generated in its cluster and its private half never leaves it (kept as a
 * PKCS#8 PEM in a Secret); only the public half travels. The pair never prints its private half: text, JSON and
 * `util.inspect` give a fixed placeholder.
 */
export class SigningKeyPair
{
    private static readonly KeyType = 'ed25519'
    private static readonly Pem = 'pem'
    private static readonly Pkcs8 = 'pkcs8'
    private static readonly Redacted = '[signing key pair]'

    private constructor(private readonly privateKey: KeyObject, public readonly PublicKey: SigningPublicKey)
    {
    }

    public static Generate(): SigningKeyPair
    {
        const pair = generateKeyPairSync(SigningKeyPair.KeyType)
        return new SigningKeyPair(pair.privateKey, SigningPublicKey.FromKeyObject(pair.publicKey))
    }

    /** A PKCS#8 PEM, as written by `PrivatePem`. */
    public static FromPrivatePem(pem: string): SigningKeyPair
    {
        let key: KeyObject
        try
        {
            key = createPrivateKey(pem)
        }
        catch
        {
            throw new SigningKeyError()
        }
        if (!KeyEncoding.IsType(key, CurveKeyType.Ed25519))
        {
            throw new SigningKeyError()
        }
        return new SigningKeyPair(key, SigningPublicKey.FromKeyObject(createPublicKey(key)))
    }

    public get KeyId(): string
    {
        return this.PublicKey.KeyId
    }

    public Sign(data: Buffer): Buffer
    {
        return sign(null, data, this.privateKey)
    }

    /** The private half for the agent's own Secret; never sent anywhere. */
    public PrivatePem(): string
    {
        return this.privateKey.export({ format: SigningKeyPair.Pem, type: SigningKeyPair.Pkcs8 }) as string
    }

    public toString(): string
    {
        return SigningKeyPair.Redacted
    }

    public toJSON(): string
    {
        return SigningKeyPair.Redacted
    }

    public [inspect.custom](): string
    {
        return SigningKeyPair.Redacted
    }
}
