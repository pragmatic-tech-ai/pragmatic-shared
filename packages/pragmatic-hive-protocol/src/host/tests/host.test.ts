import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SealingKeyPair } from '../../crypto/sealing-key.js'
import { SealedBlobError } from '../../crypto/sealed-blob.js'
import { SigningKeyPair } from '../../crypto/signing-key.js'
import { Participant } from '../../envelope/participant.js'
import { ProtocolDecodeError } from '../../wire/protocol-decode-error.js'
import { ClusterKind, HostEnrolmentRequest } from '../host-enrolment.js'
import { HostHealth, HostReport, PlacementState, PlacementStatus, Resources } from '../host-report.js'
import { ApiServerAddress, ClusterCredentialHandover, PlacementFailure, PlacementRequest, PlacementResult } from '../placement.js'

class Samples
{
    public static readonly Chart = 'sha256:' + 'c'.repeat(64)

    public static Place(): PlacementRequest
    {
        return PlacementRequest.Place({ PlacementId: 'p-1', Version: 1, Tenant: 'acme', EnrolmentCode: 'abcdefghijklmnop0123', EngineVersion: '0.10.0', ChartDigest: Samples.Chart, HiveHostName: 'acme.hives.pragmatic-tech.ai' })
    }
}

describe('HostEnrolmentRequest', () =>
{
    it('round-trips and refuses a bad mesh address or cluster kind', () =>
    {
        const request = HostEnrolmentRequest.Create({ EnrolmentCode: 'abcdefghijklmnop0123', MachineName: 'hive-laptop', PublicKey: SigningKeyPair.Generate().PublicKey, ClusterKind: ClusterKind.Kind, AgentVersion: '0.10.0', MeshAddress: '100.64.0.7' })
        assert.deepEqual(HostEnrolmentRequest.Parse(request.ToJson()).ToJson(), request.ToJson())
        assert.throws(() => HostEnrolmentRequest.Parse({ ...request.ToJson(), MeshAddress: 'my laptop' }), ProtocolDecodeError)
        assert.throws(() => HostEnrolmentRequest.Parse({ ...request.ToJson(), ClusterKind: 'docker' }), ProtocolDecodeError)
    })
})

describe('HostReport', () =>
{
    it('carries capacity, allocatable, hive slots and placement states, numbers and enums only', () =>
    {
        const report = HostReport.Create({ AgentVersion: '0.10.0', Health: HostHealth.Healthy, Capacity: new Resources(16000, 65536, 900), Allocatable: new Resources(8000, 30000, 400), HiveSlots: 2, Placements: [new PlacementStatus('p-1', PlacementState.Running)] })
        assert.deepEqual(HostReport.Parse(report.ToJson()).ToJson(), report.ToJson())
        assert.throws(() => HostReport.Parse({ ...report.ToJson(), Allocatable: { CpuMillicores: 17000, MemoryMiB: 1, StorageGiB: 1 } }), ProtocolDecodeError)
        assert.throws(() => HostReport.Parse({ ...report.ToJson(), Capacity: { CpuMillicores: 1.5, MemoryMiB: 1, StorageGiB: 1 } }), ProtocolDecodeError)
        assert.throws(() => HostReport.Parse({ ...report.ToJson(), Hostname: 'hive-laptop' }), ProtocolDecodeError)
    })
})

describe('PlacementRequest', () =>
{
    it('places with all details and removes with none', () =>
    {
        assert.deepEqual(PlacementRequest.Parse(Samples.Place().ToJson()).ToJson(), Samples.Place().ToJson())
        assert.equal(PlacementRequest.Remove('p-1', 'acme', 2).EnrolmentCode, null)
        assert.throws(() => PlacementRequest.Parse({ ...Samples.Place().ToJson(), ChartDigest: null }), ProtocolDecodeError)
        assert.throws(() => PlacementRequest.Parse({ ...PlacementRequest.Remove('p-1', 'acme', 2).ToJson(), EngineVersion: '0.10.0' }), ProtocolDecodeError)
        assert.throws(() => PlacementRequest.Parse({ ...Samples.Place().ToJson(), HiveHostName: 'acme.example.com' }), ProtocolDecodeError)
    })

    it('carries the placement version, an integer from 1, on a place and a removal', () =>
    {
        assert.equal(Samples.Place().Version, 1)
        assert.equal(PlacementRequest.Parse(PlacementRequest.Remove('p-1', 'acme', 7).ToJson()).Version, 7)
        for (const bad of [0, -1, 1.5, '2', null, undefined])
        {
            assert.throws(() => PlacementRequest.Parse({ ...Samples.Place().ToJson(), Version: bad }), ProtocolDecodeError, String(bad))
        }
    })
})

describe('PlacementResult', () =>
{
    it('names the credential reference and API server when placed, a failure code when failed, never the credential', () =>
    {
        const placed = PlacementResult.Placed('p-1', 3, new ApiServerAddress('100.64.0.7', 6443))
        assert.equal(placed.CredentialReference, 'clusters/p-1')
        assert.deepEqual(PlacementResult.Parse(placed.ToJson()).ToJson(), placed.ToJson())
        assert.equal(PlacementResult.Failed('p-1', 3, PlacementFailure.NoCapacity).CredentialReference, null)
        assert.equal(PlacementResult.Removed('p-1', 3).ApiServer, null)
        assert.throws(() => PlacementResult.Parse({ ...placed.ToJson(), Kubeconfig: 'apiVersion: v1' }), ProtocolDecodeError)
        assert.throws(() => PlacementResult.Parse({ ...placed.ToJson(), CredentialReference: 'clusters/p-2' }), ProtocolDecodeError)
        assert.throws(() => PlacementResult.Parse({ ...placed.ToJson(), Failure: 'no-capacity' }), ProtocolDecodeError)
        assert.throws(() => PlacementResult.Parse({ ...PlacementResult.Failed('p-1', 3, PlacementFailure.NoCapacity).ToJson(), Failure: 'disk full on /dev/sda1' }), ProtocolDecodeError)
        assert.throws(() => PlacementResult.Parse({ ...placed.ToJson(), ApiServer: { Host: '100.64.0.7', Port: 70000 } }), ProtocolDecodeError)
    })

    it('names the placement version it answers, and a credential failure has its own code', () =>
    {
        const placed = PlacementResult.Placed('p-1', 4, new ApiServerAddress('100.64.0.7', 6443))
        assert.equal(PlacementResult.Parse(placed.ToJson()).Version, 4)
        assert.throws(() => PlacementResult.Parse({ ...placed.ToJson(), Version: 0 }), ProtocolDecodeError)
        const unversioned: Record<string, unknown> = { ...placed.ToJson() }
        delete unversioned.Version
        assert.throws(() => PlacementResult.Parse(unversioned), ProtocolDecodeError)
        assert.equal(PlacementFailure.CredentialFailed, 'credential-failed')
        assert.equal(PlacementResult.Parse(PlacementResult.Failed('p-1', 4, PlacementFailure.CredentialFailed).ToJson()).Failure, PlacementFailure.CredentialFailed)
    })
})

describe('ClusterCredentialHandover', () =>
{
    it('seals the credential to the platform key, bound to host, placement, rotation and expiry', () =>
    {
        const platform = SealingKeyPair.Generate()
        const host = Participant.Host('host-1')
        const expiresAt = new Date('2026-11-27T10:00:00.000Z')
        const handover = ClusterCredentialHandover.Create({ Host: host, PlacementId: 'p-1', Rotation: 1, ExpiresAt: expiresAt, Credential: Buffer.from('apiVersion: v1\nkind: Config'), SealingKey: platform.PublicKey })
        const wire = JSON.stringify(handover.ToJson())
        assert.ok(!wire.includes('apiVersion'))
        const received = ClusterCredentialHandover.Parse(JSON.parse(wire))
        assert.equal(received.Open(platform, host).toString(), 'apiVersion: v1\nkind: Config')
        assert.throws(() => received.Open(platform, Participant.Host('host-2')), SealedBlobError)
        assert.throws(() => ClusterCredentialHandover.Parse({ ...handover.ToJson(), Rotation: 2 }).Open(platform, host), SealedBlobError)
        assert.throws(() => ClusterCredentialHandover.Parse({ ...handover.ToJson(), PlacementId: 'p-2' }), ProtocolDecodeError)
        assert.throws(() => received.Open(SealingKeyPair.Generate(), host), SealedBlobError)
    })
})
