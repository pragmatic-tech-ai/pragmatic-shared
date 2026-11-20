import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { inspect } from 'node:util'
import { DecodeReason, ProtocolDecodeError } from '../wire/protocol-decode-error.js'
import { CurveKeyType, KeyEncoding } from './key-encoding.js'

/** A key that is not an X25519 key, or a PEM that is not one. */
export class SealingKeyError extends Error
{
    private static readonly ErrorName = 'SealingKeyError'
    private static readonly Text = 'The key is not an X25519 key.'

    public constructor()
    {
        super(SealingKeyError.Text)
        this.name = SealingKeyError.ErrorName
    }
}

/** The public half of the platform's X25519 sealing key: what a host agent seals a cluster credential to. */
export class SealingPublicKey
{
    private static readonly Path = 'key'

    private constructor(public readonly Key: KeyObject, public readonly Raw: string)
    {
    }

    public static Parse(value: unknown, path: string = SealingPublicKey.Path): SealingPublicKey
    {
        if (typeof value !== 'string')
        {
            throw new ProtocolDecodeError(path, DecodeReason.NotString)
        }
        return new SealingPublicKey(KeyEncoding.Import(value, CurveKeyType.X25519, path), value)
    }

    public static FromKeyObject(key: KeyObject): SealingPublicKey
    {
        if (!KeyEncoding.IsType(key, CurveKeyType.X25519))
        {
            throw new SealingKeyError()
        }
        return new SealingPublicKey(key, KeyEncoding.Raw(key))
    }

    public get KeyId(): string
    {
        return KeyEncoding.KeyId(this.Raw, CurveKeyType.X25519)
    }

    public Equals(other: SealingPublicKey): boolean
    {
        return this.Raw === other.Raw
    }

    public ToJson(): string
    {
        return this.Raw
    }
}

/**
 * The platform's X25519 sealing key pair, separate from its Ed25519 signing key (one key, one purpose). The private
 * half stays in the platform's key store; the pair never prints it.
 */
export class SealingKeyPair
{
    private static readonly KeyType = 'x25519'
    private static readonly Pem = 'pem'
    private static readonly Pkcs8 = 'pkcs8'
    private static readonly Redacted = '[sealing key pair]'

    private constructor(private readonly privateKey: KeyObject, public readonly PublicKey: SealingPublicKey)
    {
    }

    public static Generate(): SealingKeyPair
    {
        const pair = generateKeyPairSync(SealingKeyPair.KeyType)
        return new SealingKeyPair(pair.privateKey, SealingPublicKey.FromKeyObject(pair.publicKey))
    }

    public static FromPrivatePem(pem: string): SealingKeyPair
    {
        let key: KeyObject
        try
        {
            key = createPrivateKey(pem)
        }
        catch
        {
            throw new SealingKeyError()
        }
        if (!KeyEncoding.IsType(key, CurveKeyType.X25519))
        {
            throw new SealingKeyError()
        }
        return new SealingKeyPair(key, SealingPublicKey.FromKeyObject(createPublicKey(key)))
    }

    /** The X25519 shared secret with `peer`. */
    public Agree(peer: SealingPublicKey): Buffer
    {
        return diffieHellman({ privateKey: this.privateKey, publicKey: peer.Key })
    }

    public PrivatePem(): string
    {
        return this.privateKey.export({ format: SealingKeyPair.Pem, type: SealingKeyPair.Pkcs8 }) as string
    }

    public toString(): string
    {
        return SealingKeyPair.Redacted
    }

    public toJSON(): string
    {
        return SealingKeyPair.Redacted
    }

    public [inspect.custom](): string
    {
        return SealingKeyPair.Redacted
    }
}
