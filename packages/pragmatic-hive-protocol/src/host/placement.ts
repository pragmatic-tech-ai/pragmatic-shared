import { CanonicalJson } from '../wire/canonical-json.js'
import { DecodeReason } from '../wire/protocol-decode-error.js'
import { ProtocolNames } from '../wire/protocol-names.js'
import { StrictFields } from '../wire/strict-fields.js'
import { SealedBlob, type SealedBlobJson } from '../crypto/sealed-blob.js'
import type { SealingKeyPair, SealingPublicKey } from '../crypto/sealing-key.js'
import type { Participant } from '../envelope/participant.js'
import { ConsoleAddress } from '../hive/console-address.js'

/** What a placement asks of a host. */
export enum PlacementOperation
{
    /** Create a cluster, install the engine with the enrolment code, enrol it under the tenant. */
    Place = 'place',
    /** Remove the hive's cluster from the machine. */
    Remove = 'remove',
}

export interface PlacementRequestJson
{
    PlacementId: string
    Version: number
    Operation: PlacementOperation
    Tenant: string
    EnrolmentCode: string | null
    EngineVersion: string | null
    ChartDigest: string | null
    HiveHostName: string | null
}

export interface PlacementRequestOptions
{
    PlacementId: string
    /** The placement's version (>= 1): each new request for one placement (an engine upgrade, the removal) carries a higher one. */
    Version: number
    Tenant: string
    EnrolmentCode: string
    EngineVersion: string
    ChartDigest: string
    HiveHostName: string
}

/**
 * "Host a hive for tenant T" (`MessageKind.PlacementRequest`, signed by the platform, addressed to one host, pulled
 * like an intent): the placement id, the tenant, the one-time enrolment code the new engine enrols with, the engine
 * version and its chart's digest, and the hive's host name under `hives.pragmatic-tech.ai` (what the edge relays to
 * this machine by SNI). A removal names only the placement and tenant. Every request carries the placement's version
 * (an integer from 1, raised by each new request for the placement): a host applies a placement's newest version only
 * and ignores an older one delivered late.
 */
export class PlacementRequest
{
    public static readonly Operations: readonly PlacementOperation[] = Object.values(PlacementOperation)
    public static readonly MaxVersion = Number.MAX_SAFE_INTEGER
    private static readonly Field = { PlacementId: 'PlacementId', Version: 'Version', Operation: 'Operation', Tenant: 'Tenant', EnrolmentCode: 'EnrolmentCode', EngineVersion: 'EngineVersion', ChartDigest: 'ChartDigest', HiveHostName: 'HiveHostName' } as const
    private static readonly Members: readonly string[] = Object.values(PlacementRequest.Field)

    private constructor(
        public readonly PlacementId: string,
        public readonly Version: number,
        public readonly Operation: PlacementOperation,
        public readonly Tenant: string,
        public readonly EnrolmentCode: string | null,
        public readonly EngineVersion: string | null,
        public readonly ChartDigest: string | null,
        public readonly HiveHostName: string | null)
    {
    }

    public static Place(options: PlacementRequestOptions): PlacementRequest
    {
        return PlacementRequest.Parse({ ...options, Operation: PlacementOperation.Place })
    }

    public static Remove(placementId: string, tenant: string, version: number): PlacementRequest
    {
        return PlacementRequest.Parse({ PlacementId: placementId, Version: version, Operation: PlacementOperation.Remove, Tenant: tenant, EnrolmentCode: null, EngineVersion: null, ChartDigest: null, HiveHostName: null })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): PlacementRequest
    {
        const P = PlacementRequest
        const F = P.Field
        const fields = StrictFields.Exactly(value, P.Members, path)
        const request = new PlacementRequest(
            fields.String(F.PlacementId, { Max: 63, Pattern: ProtocolNames.Label }),
            fields.Integer(F.Version, { Min: 1, Max: P.MaxVersion }),
            fields.Enum(F.Operation, P.Operations),
            fields.String(F.Tenant, { Pattern: ProtocolNames.Tenant }),
            fields.NullableString(F.EnrolmentCode, { Max: 128, Pattern: ProtocolNames.EnrolmentCode }),
            fields.NullableString(F.EngineVersion, { Pattern: ProtocolNames.Version }),
            fields.NullableString(F.ChartDigest, { Pattern: ProtocolNames.Digest }),
            fields.NullableString(F.HiveHostName, { Max: 253, Pattern: ProtocolNames.HostName }))
        const details = [request.EnrolmentCode, request.EngineVersion, request.ChartDigest, request.HiveHostName]
        const place = request.Operation === PlacementOperation.Place
        if (!details.every(detail => (detail !== null) === place))
        {
            throw fields.Refuse(F.Operation, DecodeReason.Inconsistent)
        }
        if (request.HiveHostName !== null && !ConsoleAddress.IsHiveSubdomain(request.HiveHostName))
        {
            throw fields.Refuse(F.HiveHostName, DecodeReason.BadFormat)
        }
        return request
    }

    public ToJson(): PlacementRequestJson
    {
        return {
            PlacementId: this.PlacementId,
            Version: this.Version,
            Operation: this.Operation,
            Tenant: this.Tenant,
            EnrolmentCode: this.EnrolmentCode,
            EngineVersion: this.EngineVersion,
            ChartDigest: this.ChartDigest,
            HiveHostName: this.HiveHostName,
        }
    }
}

/** How a placement ended. */
export enum PlacementOutcome
{
    Placed = 'placed',
    Removed = 'removed',
    Failed = 'failed',
}

/** Why a placement failed: a fixed set, no text. */
export enum PlacementFailure
{
    NoCapacity = 'no-capacity',
    ClusterCreateFailed = 'cluster-create-failed',
    EngineInstallFailed = 'engine-install-failed',
    EnrolmentFailed = 'enrolment-failed',
    RemoveFailed = 'remove-failed',
    /** The cluster runs, but its credential could not be issued or handed over. */
    CredentialFailed = 'credential-failed',
    Unsupported = 'unsupported',
}

/** The mesh address of a placed cluster's API server. */
export class ApiServerAddress
{
    private static readonly Field = { Host: 'Host', Port: 'Port' } as const
    private static readonly Members: readonly string[] = Object.values(ApiServerAddress.Field)

    public constructor(public readonly Host: string, public readonly Port: number)
    {
    }

    public static Parse(value: unknown, path: string): ApiServerAddress
    {
        const F = ApiServerAddress.Field
        const fields = StrictFields.Exactly(value, ApiServerAddress.Members, path)
        const host = fields.String(F.Host, { Max: 253 })
        if (!ProtocolNames.IsAddress(host))
        {
            throw fields.Refuse(F.Host, DecodeReason.BadFormat)
        }
        return new ApiServerAddress(host, fields.Integer(F.Port, { Min: 1, Max: ProtocolNames.MaxPort }))
    }

    public ToJson(): { Host: string, Port: number }
    {
        return { Host: this.Host, Port: this.Port }
    }
}

export interface PlacementResultJson
{
    PlacementId: string
    Version: number
    Outcome: PlacementOutcome
    Failure: PlacementFailure | null
    CredentialReference: string | null
    ApiServer: { Host: string, Port: number } | null
}

/**
 * The host's answer to a placement (`MessageKind.PlacementResult`, signed by the host key). A placed hive names the
 * reference its cluster credential is stored under on the platform (`clusters/<placement id>`) and its API server's
 * mesh address, never the credential itself: that travels sealed in a `ClusterCredentialHandover`. A failure carries
 * a code, never text. It names the placement version it answers (the request's `Version`).
 */
export class PlacementResult
{
    public static readonly Outcomes: readonly PlacementOutcome[] = Object.values(PlacementOutcome)
    public static readonly Failures: readonly PlacementFailure[] = Object.values(PlacementFailure)
    private static readonly Field = { PlacementId: 'PlacementId', Version: 'Version', Outcome: 'Outcome', Failure: 'Failure', CredentialReference: 'CredentialReference', ApiServer: 'ApiServer' } as const
    private static readonly Members: readonly string[] = Object.values(PlacementResult.Field)

    private constructor(
        public readonly PlacementId: string,
        public readonly Version: number,
        public readonly Outcome: PlacementOutcome,
        public readonly Failure: PlacementFailure | null,
        public readonly CredentialReference: string | null,
        public readonly ApiServer: ApiServerAddress | null)
    {
    }

    public static Placed(placementId: string, version: number, apiServer: ApiServerAddress): PlacementResult
    {
        return PlacementResult.Parse({ PlacementId: placementId, Version: version, Outcome: PlacementOutcome.Placed, Failure: null, CredentialReference: ClusterCredentialHandover.ReferenceFor(placementId), ApiServer: apiServer.ToJson() })
    }

    public static Removed(placementId: string, version: number): PlacementResult
    {
        return PlacementResult.Parse({ PlacementId: placementId, Version: version, Outcome: PlacementOutcome.Removed, Failure: null, CredentialReference: null, ApiServer: null })
    }

    public static Failed(placementId: string, version: number, failure: PlacementFailure): PlacementResult
    {
        return PlacementResult.Parse({ PlacementId: placementId, Version: version, Outcome: PlacementOutcome.Failed, Failure: failure, CredentialReference: null, ApiServer: null })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): PlacementResult
    {
        const P = PlacementResult
        const F = P.Field
        const fields = StrictFields.Exactly(value, P.Members, path)
        const result = new PlacementResult(
            fields.String(F.PlacementId, { Max: 63, Pattern: ProtocolNames.Label }),
            fields.Integer(F.Version, { Min: 1, Max: PlacementRequest.MaxVersion }),
            fields.Enum(F.Outcome, P.Outcomes),
            fields.NullableEnum(F.Failure, P.Failures),
            fields.NullableString(F.CredentialReference, { Max: 128, Pattern: ProtocolNames.CredentialReference }),
            fields.NullableRead(F.ApiServer, (raw, at) => ApiServerAddress.Parse(raw, at)))
        const placed = result.Outcome === PlacementOutcome.Placed
        if ((result.Failure !== null) !== (result.Outcome === PlacementOutcome.Failed))
        {
            throw fields.Refuse(F.Failure, DecodeReason.Inconsistent)
        }
        if ((result.ApiServer !== null) !== placed)
        {
            throw fields.Refuse(F.ApiServer, DecodeReason.Inconsistent)
        }
        if (placed ? result.CredentialReference !== ClusterCredentialHandover.ReferenceFor(result.PlacementId) : result.CredentialReference !== null)
        {
            throw fields.Refuse(F.CredentialReference, DecodeReason.Inconsistent)
        }
        return result
    }

    public ToJson(): PlacementResultJson
    {
        return {
            PlacementId: this.PlacementId,
            Version: this.Version,
            Outcome: this.Outcome,
            Failure: this.Failure,
            CredentialReference: this.CredentialReference,
            ApiServer: this.ApiServer?.ToJson() ?? null,
        }
    }
}

export interface ClusterCredentialHandoverJson
{
    PlacementId: string
    CredentialReference: string
    Rotation: number
    ExpiresAt: string
    Sealed: SealedBlobJson
}

export interface ClusterCredentialHandoverOptions
{
    Host: Participant
    PlacementId: string
    Rotation: number
    ExpiresAt: Date
    Credential: Buffer
    SealingKey: SealingPublicKey
}

/**
 * A placed cluster's credential, handed to the platform sealed (`MessageKind.ClusterCredentialHandover`, signed by
 * the host key): the kubeconfig bytes sealed to the platform's X25519 sealing key, with the host, placement,
 * reference, rotation number and expiry as authenticated context. The platform opens it straight into its secret
 * store under the reference; the edge and any log on the way see only ciphertext. Each rotation hands over a new
 * credential with a higher number; the platform keeps the newest.
 */
export class ClusterCredentialHandover
{
    private static readonly ReferencePrefix = 'clusters/'
    private static readonly Field = { PlacementId: 'PlacementId', CredentialReference: 'CredentialReference', Rotation: 'Rotation', ExpiresAt: 'ExpiresAt', Sealed: 'Sealed' } as const
    private static readonly Members: readonly string[] = Object.values(ClusterCredentialHandover.Field)

    private constructor(
        public readonly PlacementId: string,
        public readonly CredentialReference: string,
        public readonly Rotation: number,
        public readonly ExpiresAt: Date,
        public readonly Sealed: SealedBlob)
    {
    }

    /** The one reference a placement's credential is stored under. */
    public static ReferenceFor(placementId: string): string
    {
        return ClusterCredentialHandover.ReferencePrefix + placementId
    }

    public static Create(options: ClusterCredentialHandoverOptions): ClusterCredentialHandover
    {
        const C = ClusterCredentialHandover
        const reference = C.ReferenceFor(options.PlacementId)
        const context = C.Context(options.Host, options.PlacementId, reference, options.Rotation, options.ExpiresAt)
        const sealed = SealedBlob.Seal(options.Credential, options.SealingKey, context)
        return C.Parse({ PlacementId: options.PlacementId, CredentialReference: reference, Rotation: options.Rotation, ExpiresAt: options.ExpiresAt.toISOString(), Sealed: sealed.ToJson() })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): ClusterCredentialHandover
    {
        const C = ClusterCredentialHandover
        const F = C.Field
        const fields = StrictFields.Exactly(value, C.Members, path)
        const handover = new ClusterCredentialHandover(
            fields.String(F.PlacementId, { Max: 63, Pattern: ProtocolNames.Label }),
            fields.String(F.CredentialReference, { Max: 128, Pattern: ProtocolNames.CredentialReference }),
            fields.Integer(F.Rotation, { Min: 1 }),
            fields.Timestamp(F.ExpiresAt),
            fields.Read(F.Sealed, (raw, at) => SealedBlob.Parse(raw, at)))
        if (handover.CredentialReference !== C.ReferenceFor(handover.PlacementId))
        {
            throw fields.Refuse(F.CredentialReference, DecodeReason.Inconsistent)
        }
        return handover
    }

    /** The credential, for the platform's sealing key pair, when `host` (the verified issuer) sealed it for this context. */
    public Open(sealingKey: SealingKeyPair, host: Participant): Buffer
    {
        return this.Sealed.Open(sealingKey, ClusterCredentialHandover.Context(host, this.PlacementId, this.CredentialReference, this.Rotation, this.ExpiresAt))
    }

    public ToJson(): ClusterCredentialHandoverJson
    {
        return {
            PlacementId: this.PlacementId,
            CredentialReference: this.CredentialReference,
            Rotation: this.Rotation,
            ExpiresAt: this.ExpiresAt.toISOString(),
            Sealed: this.Sealed.ToJson(),
        }
    }

    private static Context(host: Participant, placementId: string, reference: string, rotation: number, expiresAt: Date): Buffer
    {
        return CanonicalJson.Bytes({ Host: host.ToJson(), PlacementId: placementId, CredentialReference: reference, Rotation: rotation, ExpiresAt: expiresAt.toISOString() })
    }
}
