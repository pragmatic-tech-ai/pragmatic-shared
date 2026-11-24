import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SigningKeyPair } from '../../crypto/signing-key.js'
import { EnrolmentMismatch, EnrolmentMismatchError } from '../../channel/enrolment-handshake.js'
import { MessageKind } from '../../envelope/message-kind.js'
import { EnvelopeSigningError } from '../../envelope/envelope-signer.js'
import { ProtocolVerificationError, VerificationFailure } from '../../envelope/protocol-verification-error.js'
import { HiveLevel } from '../../hive/hive-level.js'
import { ClusterKind } from '../../host/host-enrolment.js'
import { HostHealth, HostReport, Resources } from '../../host/host-report.js'
import { ApiServerAddress, PlacementRequest, PlacementResult } from '../../host/placement.js'
import { ComponentAtVersion, CreateEnvironment, EnvironmentPurpose } from '../../intent/intent-action.js'
import { Intent, IntentApplyMode } from '../../intent/intent.js'
import { IntentDecision, IntentDecisionKind, RealmSubject } from '../../intent/intent-decision.js'
import { ComponentReport, ComponentState, EnvironmentReadiness, EnvironmentStatus, HiveReport, IntentProgress, IntentStatus } from '../../report/hive-report.js'
import { FakeAgentChannel } from '../fake-agent-channel.js'
import { FakeHiveAgent, FakeHostAgent } from '../fake-agents.js'
import { FakeClock } from '../fake-clock.js'
import { FakePlatform, FakePlatformRefusal, FakePlatformRefusalError } from '../fake-platform.js'

class World
{
    public readonly Clock = new FakeClock()
    public readonly Platform = new FakePlatform(this.Clock)
    public readonly Channel = new FakeAgentChannel(this.Platform)

    public Hive(pinned?: SigningKeyPair): FakeHiveAgent
    {
        return new FakeHiveAgent(this.Channel, this.Clock, pinned?.PublicKey)
    }

    public async EnrolledHive(level: HiveLevel = HiveLevel.Enrolled): Promise<FakeHiveAgent>
    {
        const hive = this.Hive()
        await hive.Enrol(this.Platform.IssueHiveCode('acme', level), 'acme', level)
        return hive
    }
}

class Samples
{
    public static readonly Approver = RealmSubject.Of('acme', 'u-42')

    public static Component(): ComponentAtVersion
    {
        return new ComponentAtVersion('tenant-admin', '0.10.0', 'sha256:' + 'a'.repeat(64), 'sha256:' + 'b'.repeat(64), null)
    }
}

describe('enrolment over the fake channel', () =>
{
    it('records the hive by public key only and hands it its id, the trust root and the channel URL', async () =>
    {
        const world = new World()
        const hive = world.Hive()
        const response = await hive.Enrol(world.Platform.IssueHiveCode('acme', HiveLevel.Delegated), 'acme', HiveLevel.Delegated)
        assert.ok(response.TrustRoot.Equals(world.Platform.TrustRoot))
        assert.equal(response.ChannelUrl, FakePlatform.DefaultChannelUrl)
        assert.equal(hive.Self.Id, response.HiveId)
        assert.ok(world.Platform.Record(hive.Self)?.PublicKey.Equals(hive.Key.PublicKey))
        assert.ok(world.Channel.Wire.every(entry => !entry.Text.includes('PRIVATE KEY')))
    })

    it('uses a code once, and only for the tenant and level it was issued for', async () =>
    {
        const world = new World()
        const code = world.Platform.IssueHiveCode('acme', HiveLevel.Enrolled)
        await world.Hive().Enrol(code, 'acme', HiveLevel.Enrolled)
        await assert.rejects(world.Hive().Enrol(code, 'acme', HiveLevel.Enrolled), (error: unknown) => error instanceof FakePlatformRefusalError && error.Refusal === FakePlatformRefusal.UnknownCode)
        await assert.rejects(world.Hive().Enrol(world.Platform.IssueHiveCode('acme', HiveLevel.Enrolled), 'acme', HiveLevel.Delegated), (error: unknown) => error instanceof FakePlatformRefusalError && error.Refusal === FakePlatformRefusal.CodeMismatch)
        await assert.rejects(world.Hive().Enrol(world.Platform.IssueHostCode(), 'acme', HiveLevel.Enrolled), FakePlatformRefusalError)
    })

    it('refuses a captured enrolment request replayed, and a request whose key was swapped in transit', async () =>
    {
        const world = new World()
        await world.Hive().Enrol(world.Platform.IssueHiveCode('acme', HiveLevel.Enrolled), 'acme', HiveLevel.Enrolled)
        await assert.rejects(world.Channel.Resend(world.Channel.Sent[0] as string), (error: unknown) => error instanceof ProtocolVerificationError && error.Failure === VerificationFailure.Replayed)
        const other = SigningKeyPair.Generate().PublicKey.Raw
        world.Channel.TamperNext(text => { const json = JSON.parse(text); json.Body.PublicKey = other; return JSON.stringify(json) })
        await assert.rejects(world.Hive().Enrol(world.Platform.IssueHiveCode('acme', HiveLevel.Enrolled), 'acme', HiveLevel.Enrolled), ProtocolVerificationError)
    })

    it('refuses a trust root other than the pinned one the engine was installed with', async () =>
    {
        const world = new World()
        const hive = world.Hive(SigningKeyPair.Generate())
        await assert.rejects(hive.Enrol(world.Platform.IssueHiveCode('acme', HiveLevel.Enrolled), 'acme', HiveLevel.Enrolled), (error: unknown) => error instanceof EnrolmentMismatchError && error.Reason === EnrolmentMismatch.UntrustedRoot)
        assert.equal(hive.Enrolled, false)
        const pinned = new FakeHiveAgent(world.Channel, world.Clock, world.Platform.TrustRoot)
        await pinned.Enrol(world.Platform.IssueHiveCode('acme', HiveLevel.Enrolled), 'acme', HiveLevel.Enrolled)
        assert.equal(pinned.Enrolled, true)
    })
})

describe('intents over the fake channel', () =>
{
    it('Enrolled: the intent waits for approval; the approval names the realm subject and the exact intent', async () =>
    {
        const world = new World()
        const hive = await world.EnrolledHive(HiveLevel.Enrolled)
        world.Platform.PublishIntent(hive.Self.Id, Samples.Component())
        const [intent] = await hive.PullIntents()
        assert.ok(intent !== undefined)
        assert.equal(hive.ModeFor(intent), IntentApplyMode.AwaitApproval)
        world.Clock.Advance(3_600_000)
        await hive.Decide(intent, IntentDecisionKind.Approved, Samples.Approver)
        const [decision] = world.Platform.ReceivedOf<IntentDecision>(MessageKind.IntentDecision)
        assert.equal(decision?.Decision, IntentDecisionKind.Approved)
        assert.equal(decision?.Approver.Subject, 'u-42')
        assert.equal(decision?.IntentDigest, intent.Digest)
        assert.deepEqual(await hive.PullIntents(), [])
    })

    it('Delegated: the intent applies directly; a Delegated hive still waits on an intent issued as Enrolled', async () =>
    {
        const world = new World()
        const hive = await world.EnrolledHive(HiveLevel.Delegated)
        world.Platform.PublishIntent(hive.Self.Id, new CreateEnvironment('staging', EnvironmentPurpose.Development, null))
        world.Platform.PublishIntent(hive.Self.Id, new CreateEnvironment('prod', EnvironmentPurpose.Runtime, null), { Level: HiveLevel.Enrolled })
        const [delegated, enrolled] = await hive.PullIntents()
        assert.equal(hive.ModeFor(delegated!), IntentApplyMode.ApplyDirectly)
        assert.equal(hive.ModeFor(enrolled!), IntentApplyMode.AwaitApproval)
        hive.Level = HiveLevel.Enrolled
        assert.equal(hive.ModeFor(delegated!), IntentApplyMode.AwaitApproval)
    })

    it('an approval after the intent expired is refused at the hive', async () =>
    {
        const world = new World()
        const hive = await world.EnrolledHive()
        world.Platform.PublishIntent(hive.Self.Id, Samples.Component(), { LifetimeMs: 86_400_000 })
        const [intent] = await hive.PullIntents()
        world.Clock.Advance(2 * 86_400_000)
        await assert.rejects(hive.Decide(intent!, IntentDecisionKind.Approved, Samples.Approver), (error: unknown) => error instanceof ProtocolVerificationError && error.Failure === VerificationFailure.Expired)
    })

    it('a hive does not accept an intent addressed to another hive, nor one not signed by its trust root', async () =>
    {
        const world = new World()
        const first = await world.EnrolledHive()
        const second = await world.EnrolledHive()
        const stolen = world.Platform.PublishIntent(first.Self.Id, Samples.Component())
        await assert.rejects(second.Verifier().Verify(stolen, MessageKind.Intent, Intent), (error: unknown) => error instanceof ProtocolVerificationError && error.Failure === VerificationFailure.WrongAudience)
        const rogue = new FakePlatform(world.Clock)
        const forged = rogue.PublishIntent(first.Self.Id, Samples.Component())
        await assert.rejects(first.Verifier().Verify(forged, MessageKind.Intent, Intent), (error: unknown) => error instanceof ProtocolVerificationError && error.Failure === VerificationFailure.KeyMismatch)
    })

    it('a decision for an intent never issued to the hive is refused by the platform', async () =>
    {
        const world = new World()
        const first = await world.EnrolledHive()
        const second = await world.EnrolledHive()
        world.Platform.PublishIntent(first.Self.Id, Samples.Component())
        const [intent] = await first.PullIntents()
        await assert.rejects(second.Send(MessageKind.IntentDecision, IntentDecision.For(intent!, IntentDecisionKind.Approved, Samples.Approver, world.Clock.Now())), (error: unknown) => error instanceof FakePlatformRefusalError && error.Refusal === FakePlatformRefusal.UnknownIntent)
    })
})

describe('reports over the fake channel', () =>
{
    it('the platform takes a verified, closed report and refuses a tampered or replayed one', async () =>
    {
        const world = new World()
        const hive = await world.EnrolledHive()
        const report = HiveReport.Create({
            EngineVersion: '0.10.0',
            Components: [new ComponentReport('hive-agent', ComponentState.Ready, '0.10.0')],
            Environments: [new EnvironmentStatus('prod', EnvironmentReadiness.Ready, '1.3.0')],
            Intents: [IntentStatus.Of('intent-1', IntentProgress.Applied)],
        })
        await hive.Report(report)
        assert.deepEqual(world.Platform.ReceivedOf<HiveReport>(MessageKind.HiveReport)[0]?.ToJson(), report.ToJson())
        await assert.rejects(world.Channel.Resend(world.Channel.Sent.at(-1) as string), (error: unknown) => error instanceof ProtocolVerificationError && error.Failure === VerificationFailure.Replayed)
        world.Channel.TamperNext(text => text.replace('"ready"', '"degraded"'))
        await assert.rejects(hive.Report(report), (error: unknown) => error instanceof ProtocolVerificationError && error.Failure === VerificationFailure.BadSignature)
        world.Clock.Advance(10 * 60_000)
        const late = world.Channel.Sent.at(-1) as string
        await assert.rejects(world.Channel.Resend(late), ProtocolVerificationError)
    })
})

describe('the host agent over the fake channel (Hosted path)', () =>
{
    it('enrols, reports capacity, pulls a placement, answers with a reference and hands the credential over sealed', async () =>
    {
        const world = new World()
        const host = new FakeHostAgent(world.Channel, world.Clock)
        const enrolment = await host.Enrol(world.Platform.IssueHostCode(), 'hive-laptop', ClusterKind.Kind, '100.64.0.7')
        assert.ok(enrolment.SealingKey.Equals(world.Platform.SealingKey.PublicKey))
        await host.Report(HostReport.Create({ AgentVersion: '0.10.0', Health: HostHealth.Healthy, Capacity: new Resources(16000, 65536, 900), Allocatable: new Resources(16000, 65536, 900), HiveSlots: 1, Placements: [] }))

        const hiveCode = world.Platform.IssueHiveCode('acme', HiveLevel.Hosted)
        world.Platform.Place(host.Self.Id, PlacementRequest.Place({ PlacementId: 'p-1', Tenant: 'acme', EnrolmentCode: hiveCode, EngineVersion: '0.10.0', ChartDigest: 'sha256:' + 'c'.repeat(64), HiveHostName: 'acme.hives.pragmatic-tech.ai' }))
        const [placement] = await host.PullPlacements()
        assert.equal(placement?.Body.EnrolmentCode, hiveCode)

        const engine = world.Hive()
        await engine.Enrol(hiveCode, 'acme', HiveLevel.Hosted)
        await host.Result(PlacementResult.Placed('p-1', new ApiServerAddress('100.64.0.7', 6443)))
        await host.HandOver('p-1', 1, Buffer.from('apiVersion: v1\nkind: Config'), new Date('2026-11-27T10:00:00.000Z'))
        await host.Hello(['acme.hives.pragmatic-tech.ai'])

        assert.equal(world.Platform.ReceivedOf<PlacementResult>(MessageKind.PlacementResult)[0]?.CredentialReference, 'clusters/p-1')
        assert.equal(world.Platform.Credentials.get('clusters/p-1')?.toString(), 'apiVersion: v1\nkind: Config')
        assert.ok(world.Channel.Wire.every(entry => !entry.Text.includes('apiVersion')))
        assert.ok(world.Platform.ReceivedOf(MessageKind.TunnelHello).length === 1)
    })

    it('a hive key cannot sign host messages', async () =>
    {
        const world = new World()
        const hive = await world.EnrolledHive()
        await assert.rejects(hive.Send(MessageKind.PlacementResult, PlacementResult.Removed('p-1')), EnvelopeSigningError)
    })
})
