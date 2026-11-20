import { SealingPublicKey } from '../crypto/sealing-key.js'
import { SigningPublicKey } from '../crypto/signing-key.js'
import { DecodeReason } from '../wire/protocol-decode-error.js'
import { ProtocolNames } from '../wire/protocol-names.js'
import { StrictFields } from '../wire/strict-fields.js'

/** How a hosting machine creates clusters: k3s on Linux, kind on a WSL machine. */
export enum ClusterKind
{
    K3s = 'k3s',
    Kind = 'kind',
}

export interface HostEnrolmentRequestJson
{
    EnrolmentCode: string
    MachineName: string
    PublicKey: string
    ClusterKind: ClusterKind
    AgentVersion: string
    MeshAddress: string
}

export interface HostEnrolmentRequestOptions
{
    EnrolmentCode: string
    MachineName: string
    PublicKey: SigningPublicKey
    ClusterKind: ClusterKind
    AgentVersion: string
    MeshAddress: string
}

/**
 * A hosting machine's host agent enrolling, once, with a code from the platform admin console: its machine name, its
 * own Ed25519 public key (generated on the machine), the cluster technology it uses, its version, and its mesh
 * address (where the platform reaches the clusters it creates). Self-signed like a hive's request.
 */
export class HostEnrolmentRequest
{
    public static readonly ClusterKinds: readonly ClusterKind[] = Object.values(ClusterKind)
    private static readonly Field = { EnrolmentCode: 'EnrolmentCode', MachineName: 'MachineName', PublicKey: 'PublicKey', ClusterKind: 'ClusterKind', AgentVersion: 'AgentVersion', MeshAddress: 'MeshAddress' } as const
    private static readonly Members: readonly string[] = Object.values(HostEnrolmentRequest.Field)

    private constructor(
        public readonly EnrolmentCode: string,
        public readonly MachineName: string,
        public readonly PublicKey: SigningPublicKey,
        public readonly ClusterKind: ClusterKind,
        public readonly AgentVersion: string,
        public readonly MeshAddress: string)
    {
    }

    public static Create(options: HostEnrolmentRequestOptions): HostEnrolmentRequest
    {
        return HostEnrolmentRequest.Parse({ ...options, PublicKey: options.PublicKey.ToJson() })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): HostEnrolmentRequest
    {
        const H = HostEnrolmentRequest
        const F = H.Field
        const fields = StrictFields.Exactly(value, H.Members, path)
        const request = new HostEnrolmentRequest(
            fields.String(F.EnrolmentCode, { Max: 128, Pattern: ProtocolNames.EnrolmentCode }),
            fields.String(F.MachineName, { Max: 63, Pattern: ProtocolNames.Label }),
            fields.Read(F.PublicKey, (raw, at) => SigningPublicKey.Parse(raw, at)),
            fields.Enum(F.ClusterKind, H.ClusterKinds),
            fields.String(F.AgentVersion, { Pattern: ProtocolNames.Version }),
            fields.String(F.MeshAddress, { Max: 253 }))
        if (!ProtocolNames.IsAddress(request.MeshAddress))
        {
            throw fields.Refuse(F.MeshAddress, DecodeReason.BadFormat)
        }
        return request
    }

    public static KeyOf(request: HostEnrolmentRequest): SigningPublicKey
    {
        return request.PublicKey
    }

    public ToJson(): HostEnrolmentRequestJson
    {
        return {
            EnrolmentCode: this.EnrolmentCode,
            MachineName: this.MachineName,
            PublicKey: this.PublicKey.ToJson(),
            ClusterKind: this.ClusterKind,
            AgentVersion: this.AgentVersion,
            MeshAddress: this.MeshAddress,
        }
    }
}

export interface HostEnrolmentResponseJson
{
    HostId: string
    TrustRoot: string
    SealingKey: string
    ChannelUrl: string
    RequestNonce: string
}

export interface HostEnrolmentResponseOptions
{
    HostId: string
    TrustRoot: SigningPublicKey
    SealingKey: SealingPublicKey
    ChannelUrl: string
    RequestNonce: string
}

/**
 * The platform's answer to a host enrolment: the host id, the platform's trust root, the platform's X25519 sealing
 * key (what the host seals cluster credentials to), the channel URL and the answered request's nonce. Signed by the
 * trust root it carries.
 */
export class HostEnrolmentResponse
{
    private static readonly Field = { HostId: 'HostId', TrustRoot: 'TrustRoot', SealingKey: 'SealingKey', ChannelUrl: 'ChannelUrl', RequestNonce: 'RequestNonce' } as const
    private static readonly Members: readonly string[] = Object.values(HostEnrolmentResponse.Field)

    private constructor(
        public readonly HostId: string,
        public readonly TrustRoot: SigningPublicKey,
        public readonly SealingKey: SealingPublicKey,
        public readonly ChannelUrl: string,
        public readonly RequestNonce: string)
    {
    }

    public static Create(options: HostEnrolmentResponseOptions): HostEnrolmentResponse
    {
        return HostEnrolmentResponse.Parse({ ...options, TrustRoot: options.TrustRoot.ToJson(), SealingKey: options.SealingKey.ToJson() })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): HostEnrolmentResponse
    {
        const F = HostEnrolmentResponse.Field
        const fields = StrictFields.Exactly(value, HostEnrolmentResponse.Members, path)
        return new HostEnrolmentResponse(
            fields.String(F.HostId, { Max: 63, Pattern: ProtocolNames.Label }),
            fields.Read(F.TrustRoot, (raw, at) => SigningPublicKey.Parse(raw, at)),
            fields.Read(F.SealingKey, (raw, at) => SealingPublicKey.Parse(raw, at)),
            fields.String(F.ChannelUrl, { Max: 2048, Pattern: ProtocolNames.HttpsUrl }),
            fields.String(F.RequestNonce, { Pattern: ProtocolNames.Nonce }))
    }

    public static KeyOf(response: HostEnrolmentResponse): SigningPublicKey
    {
        return response.TrustRoot
    }

    public ToJson(): HostEnrolmentResponseJson
    {
        return {
            HostId: this.HostId,
            TrustRoot: this.TrustRoot.ToJson(),
            SealingKey: this.SealingKey.ToJson(),
            ChannelUrl: this.ChannelUrl,
            RequestNonce: this.RequestNonce,
        }
    }
}
