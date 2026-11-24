import { CanonicalJson } from '../wire/canonical-json.js'
import { DecodeReason, ProtocolDecodeError } from '../wire/protocol-decode-error.js'
import { ProtocolNames } from '../wire/protocol-names.js'
import { StrictFields } from '../wire/strict-fields.js'

/** The key types a cluster's service-account issuer signs with. */
export enum ServiceAccountKeyType
{
    Rsa = 'RSA',
    Ec = 'EC',
}

export interface ServiceAccountKeyJson
{
    kty: ServiceAccountKeyType
    kid: string
    use: string
    alg: string
    n?: string
    e?: string
    crv?: string
    x?: string
    y?: string
}

/**
 * One public key of a cluster's service-account issuer, as the API server publishes it at `/openid/v1/jwks` (members
 * named as in a JWK, RFC 7517). Public members only: a JWK member of private key material (`d`, `p`, `q`, `dp`, `dq`,
 * `qi`, `oth`, `k`) is refused at decode as such, before the shape check, and each key is at most 4 KiB.
 */
export class ServiceAccountKey
{
    public static readonly MaxBytes = 4096
    public static readonly PrivateMembers: readonly string[] = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']
    public static readonly Types: readonly ServiceAccountKeyType[] = Object.values(ServiceAccountKeyType)
    private static readonly Use = 'sig'
    private static readonly RsaAlgorithms: readonly string[] = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512']
    private static readonly EcAlgorithms: readonly string[] = ['ES256', 'ES384', 'ES512']
    private static readonly Curves: readonly string[] = ['P-256', 'P-384', 'P-521']
    private static readonly KeyId = /^[A-Za-z0-9_-]{1,128}$/
    private static readonly Base64Url = /^[A-Za-z0-9_-]+$/
    private static readonly Field = { Type: 'kty', KeyId: 'kid', Use: 'use', Algorithm: 'alg', Modulus: 'n', Exponent: 'e', Curve: 'crv', X: 'x', Y: 'y' } as const
    private static readonly RsaMembers: readonly string[] = [ServiceAccountKey.Field.Type, ServiceAccountKey.Field.KeyId, ServiceAccountKey.Field.Use, ServiceAccountKey.Field.Algorithm, ServiceAccountKey.Field.Modulus, ServiceAccountKey.Field.Exponent]
    private static readonly EcMembers: readonly string[] = [ServiceAccountKey.Field.Type, ServiceAccountKey.Field.KeyId, ServiceAccountKey.Field.Use, ServiceAccountKey.Field.Algorithm, ServiceAccountKey.Field.Curve, ServiceAccountKey.Field.X, ServiceAccountKey.Field.Y]

    private constructor(private readonly json: ServiceAccountKeyJson)
    {
        Object.freeze(this)
    }

    public get Type(): ServiceAccountKeyType
    {
        return this.json.kty
    }

    public get KeyId(): string
    {
        return this.json.kid
    }

    public static Parse(value: unknown, path: string): ServiceAccountKey
    {
        const S = ServiceAccountKey
        const F = S.Field
        const raw = StrictFields.Of(value, path)
        for (const member of S.PrivateMembers)
        {
            if (Object.hasOwn(value as object, member)) throw raw.Refuse(member, DecodeReason.PrivateKeyMaterial)
        }
        if (CanonicalJson.Bytes(value).length > S.MaxBytes) throw new ProtocolDecodeError(path, DecodeReason.TooLarge)
        const type = raw.Enum(F.Type, S.Types)
        const fields = StrictFields.Exactly(value, type === ServiceAccountKeyType.Rsa ? S.RsaMembers : S.EcMembers, path)
        const keyId = fields.String(F.KeyId, { Pattern: S.KeyId, Max: 128 })
        const use = fields.Enum(F.Use, [S.Use])
        const encoded = { Pattern: S.Base64Url, Max: S.MaxBytes }
        if (type === ServiceAccountKeyType.Rsa)
        {
            const alg = fields.Enum(F.Algorithm, S.RsaAlgorithms)
            return new ServiceAccountKey({ kty: type, kid: keyId, use, alg, n: fields.String(F.Modulus, encoded), e: fields.String(F.Exponent, { Pattern: S.Base64Url, Max: 16 }) })
        }
        const alg = fields.Enum(F.Algorithm, S.EcAlgorithms)
        return new ServiceAccountKey({ kty: type, kid: keyId, use, alg, crv: fields.Enum(F.Curve, S.Curves), x: fields.String(F.X, encoded), y: fields.String(F.Y, encoded) })
    }

    public ToJson(): ServiceAccountKeyJson
    {
        return { ...this.json }
    }
}

export interface ServiceAccountKeysJson
{
    Issuer: string
    Keys: ServiceAccountKeyJson[]
}

export interface ServiceAccountKeysOptions
{
    /** The cluster's service-account issuer (`--service-account-issuer`): https. */
    Issuer: string
    /** The issuer's JSON Web Key Set, as the API server's `/openid/v1/jwks` answers it (its `keys`). */
    Keys: readonly unknown[]
}

/**
 * What a hive tells the platform about its cluster's service-account issuer (`MessageKind.ServiceAccountKeys`, signed
 * by the hive key): the issuer URL and its public JWKS (RSA or EC public keys, at most 8, each at most 4 KiB). The
 * platform serves them, for Hosted hives, as the issuer's public discovery document and keys, so clouds can trust the
 * cluster's projected tokens (workload identity). Only the hive itself signs it; the platform keeps only keys a hive
 * signed for its own issuer path.
 */
export class ServiceAccountKeys
{
    public static readonly MaxKeys = 8
    private static readonly Field = { Issuer: 'Issuer', Keys: 'Keys' } as const
    private static readonly Members: readonly string[] = Object.values(ServiceAccountKeys.Field)

    private constructor(public readonly Issuer: string, public readonly Keys: readonly ServiceAccountKey[])
    {
        Object.freeze(this)
    }

    public static Create(options: ServiceAccountKeysOptions): ServiceAccountKeys
    {
        return ServiceAccountKeys.Parse({ Issuer: options.Issuer, Keys: [...options.Keys] })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): ServiceAccountKeys
    {
        const S = ServiceAccountKeys
        const F = S.Field
        const fields = StrictFields.Exactly(value, S.Members, path)
        const issuer = fields.String(F.Issuer, { Pattern: ProtocolNames.HttpsUrl, Max: 2048 })
        const keys = fields.UniqueArray(F.Keys, S.MaxKeys, (raw, at) => ServiceAccountKey.Parse(raw, at), key => key.KeyId)
        if (keys.length === 0) throw fields.Refuse(F.Keys, DecodeReason.Missing)
        return new ServiceAccountKeys(issuer, keys)
    }

    /** The issuer's JWKS document (`{ "keys": [...] }`), as the platform serves it. */
    public Jwks(): { keys: ServiceAccountKeyJson[] }
    {
        return { keys: this.Keys.map(key => key.ToJson()) }
    }

    public ToJson(): ServiceAccountKeysJson
    {
        return { Issuer: this.Issuer, Keys: this.Keys.map(key => key.ToJson()) }
    }
}
