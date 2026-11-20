import { createHash, createPublicKey, type KeyObject } from 'node:crypto'
import { DecodeReason, ProtocolDecodeError } from '../wire/protocol-decode-error.js'

/** The two curve key types the protocol uses: Ed25519 to sign, X25519 to seal. */
export enum CurveKeyType
{
    Ed25519 = 'Ed25519',
    X25519 = 'X25519',
}

/**
 * A curve public key on the wire is its raw 32 bytes in base64url (43 characters, no padding); its key id is `k` and
 * the first 40 hex digits of SHA-256 over the key type and the raw bytes, a DNS label that names the key in envelopes
 * and doubles as an unenrolled agent's id.
 */
export class KeyEncoding
{
    public static readonly RawPattern = /^[A-Za-z0-9_-]{43}$/
    public static readonly KeyIdPattern = /^k[a-f0-9]{40}$/
    private static readonly OctetKeyPair = 'OKP'
    private static readonly Jwk = 'jwk'
    private static readonly Base64Url = 'base64url'
    private static readonly HashAlgorithm = 'sha256'
    private static readonly Hex = 'hex'
    private static readonly KeyIdPrefix = 'k'
    private static readonly KeyIdDigits = 40
    private static readonly Separator = ':'
    private static readonly RawLength = 32

    public static Import(raw: string, type: CurveKeyType, path: string): KeyObject
    {
        if (!KeyEncoding.RawPattern.test(raw) || Buffer.from(raw, KeyEncoding.Base64Url).length !== KeyEncoding.RawLength)
        {
            throw new ProtocolDecodeError(path, DecodeReason.BadFormat)
        }
        try
        {
            return createPublicKey({ key: { kty: KeyEncoding.OctetKeyPair, crv: type, x: raw }, format: KeyEncoding.Jwk })
        }
        catch
        {
            throw new ProtocolDecodeError(path, DecodeReason.BadFormat)
        }
    }

    public static Raw(key: KeyObject): string
    {
        const jwk = key.export({ format: KeyEncoding.Jwk })
        return jwk.x as string
    }

    public static KeyId(raw: string, type: CurveKeyType): string
    {
        const digest = createHash(KeyEncoding.HashAlgorithm).update(type + KeyEncoding.Separator + raw).digest(KeyEncoding.Hex)
        return KeyEncoding.KeyIdPrefix + digest.slice(0, KeyEncoding.KeyIdDigits)
    }

    public static IsType(key: KeyObject, type: CurveKeyType): boolean
    {
        return key.asymmetricKeyType === type.toLowerCase()
    }
}
