import { SigningPublicKey } from '../crypto/signing-key.js'
import { ProtocolNames } from '../wire/protocol-names.js'
import { StrictFields } from '../wire/strict-fields.js'
import { ConsoleAddress, type ConsoleAddressJson } from './console-address.js'
import { HiveLevel, HiveLevels } from './hive-level.js'

export interface HiveEnrolmentRequestJson
{
    EnrolmentCode: string
    Tenant: string
    Level: HiveLevel
    PublicKey: string
    EngineVersion: string
    ConsoleAddress: ConsoleAddressJson
}

export interface HiveEnrolmentRequestOptions
{
    EnrolmentCode: string
    Tenant: string
    Level: HiveLevel
    PublicKey: SigningPublicKey
    EngineVersion: string
    ConsoleAddress: ConsoleAddress
}

/**
 * "Connect this hive": the one-time enrolment code from the personal cabinet, the tenant and level the customer admin
 * chose, the hive's public key (generated in the cluster; the private half never leaves it), the engine version and
 * the console address option. Signed by that same key (`MessageKind.HiveEnrolmentRequest`, self-signed), which
 * proves the hive holds it.
 */
export class HiveEnrolmentRequest
{
    private static readonly Field = { EnrolmentCode: 'EnrolmentCode', Tenant: 'Tenant', Level: 'Level', PublicKey: 'PublicKey', EngineVersion: 'EngineVersion', ConsoleAddress: 'ConsoleAddress' } as const
    private static readonly Members: readonly string[] = Object.values(HiveEnrolmentRequest.Field)

    private constructor(
        public readonly EnrolmentCode: string,
        public readonly Tenant: string,
        public readonly Level: HiveLevel,
        public readonly PublicKey: SigningPublicKey,
        public readonly EngineVersion: string,
        public readonly ConsoleAddress: ConsoleAddress)
    {
    }

    public static Create(options: HiveEnrolmentRequestOptions): HiveEnrolmentRequest
    {
        return HiveEnrolmentRequest.Parse({ ...options, PublicKey: options.PublicKey.ToJson(), ConsoleAddress: options.ConsoleAddress.ToJson() })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): HiveEnrolmentRequest
    {
        const F = HiveEnrolmentRequest.Field
        const fields = StrictFields.Exactly(value, HiveEnrolmentRequest.Members, path)
        return new HiveEnrolmentRequest(
            fields.String(F.EnrolmentCode, { Max: 128, Pattern: ProtocolNames.EnrolmentCode }),
            fields.String(F.Tenant, { Pattern: ProtocolNames.Tenant }),
            fields.Enum(F.Level, HiveLevels.Enrolling),
            fields.Read(F.PublicKey, (raw, at) => SigningPublicKey.Parse(raw, at)),
            fields.String(F.EngineVersion, { Pattern: ProtocolNames.Version }),
            fields.Read(F.ConsoleAddress, (raw, at) => ConsoleAddress.Parse(raw, at)))
    }

    /** The key a self-signed request is verified with. */
    public static KeyOf(request: HiveEnrolmentRequest): SigningPublicKey
    {
        return request.PublicKey
    }

    public ToJson(): HiveEnrolmentRequestJson
    {
        return {
            EnrolmentCode: this.EnrolmentCode,
            Tenant: this.Tenant,
            Level: this.Level,
            PublicKey: this.PublicKey.ToJson(),
            EngineVersion: this.EngineVersion,
            ConsoleAddress: this.ConsoleAddress.ToJson(),
        }
    }
}

export interface HiveEnrolmentResponseJson
{
    HiveId: string
    Tenant: string
    Level: HiveLevel
    TrustRoot: string
    ChannelUrl: string
    RequestNonce: string
}

export interface HiveEnrolmentResponseOptions
{
    HiveId: string
    Tenant: string
    Level: HiveLevel
    TrustRoot: SigningPublicKey
    ChannelUrl: string
    RequestNonce: string
}

/**
 * The platform's answer: the hive's id (its name on the channel from now on), the tenant and level recorded, the
 * platform's trust root (the Ed25519 public key every intent is signed with), the agent channel URL, and the nonce of
 * the request it answers. Signed by the trust root it carries (`MessageKind.HiveEnrolmentResponse`), addressed to the
 * hive by its key id.
 */
export class HiveEnrolmentResponse
{
    private static readonly Field = { HiveId: 'HiveId', Tenant: 'Tenant', Level: 'Level', TrustRoot: 'TrustRoot', ChannelUrl: 'ChannelUrl', RequestNonce: 'RequestNonce' } as const
    private static readonly Members: readonly string[] = Object.values(HiveEnrolmentResponse.Field)

    private constructor(
        public readonly HiveId: string,
        public readonly Tenant: string,
        public readonly Level: HiveLevel,
        public readonly TrustRoot: SigningPublicKey,
        public readonly ChannelUrl: string,
        public readonly RequestNonce: string)
    {
    }

    public static Create(options: HiveEnrolmentResponseOptions): HiveEnrolmentResponse
    {
        return HiveEnrolmentResponse.Parse({ ...options, TrustRoot: options.TrustRoot.ToJson() })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): HiveEnrolmentResponse
    {
        const F = HiveEnrolmentResponse.Field
        const fields = StrictFields.Exactly(value, HiveEnrolmentResponse.Members, path)
        return new HiveEnrolmentResponse(
            fields.String(F.HiveId, { Max: 63, Pattern: ProtocolNames.Label }),
            fields.String(F.Tenant, { Pattern: ProtocolNames.Tenant }),
            fields.Enum(F.Level, HiveLevels.Enrolling),
            fields.Read(F.TrustRoot, (raw, at) => SigningPublicKey.Parse(raw, at)),
            fields.String(F.ChannelUrl, { Max: 2048, Pattern: ProtocolNames.HttpsUrl }),
            fields.String(F.RequestNonce, { Pattern: ProtocolNames.Nonce }))
    }

    public static KeyOf(response: HiveEnrolmentResponse): SigningPublicKey
    {
        return response.TrustRoot
    }

    public ToJson(): HiveEnrolmentResponseJson
    {
        return {
            HiveId: this.HiveId,
            Tenant: this.Tenant,
            Level: this.Level,
            TrustRoot: this.TrustRoot.ToJson(),
            ChannelUrl: this.ChannelUrl,
            RequestNonce: this.RequestNonce,
        }
    }
}
