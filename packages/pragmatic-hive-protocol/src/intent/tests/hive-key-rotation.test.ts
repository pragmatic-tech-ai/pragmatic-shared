import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SigningKeyPair } from '../../crypto/signing-key.js'
import { EnvelopeSigner, EnvelopeSigningError } from '../../envelope/envelope-signer.js'
import { MessageKind } from '../../envelope/message-kind.js'
import { Participant } from '../../envelope/participant.js'
import { ProtocolVerificationError, VerificationFailure } from '../../envelope/protocol-verification-error.js'
import { HiveLevel } from '../../hive/hive-level.js'
import { FakeAgentChannel } from '../../testing/fake-agent-channel.js'
import { FakeHiveAgent } from '../../testing/fake-agents.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { FakePlatform, FakePlatformRefusal, FakePlatformRefusalError } from '../../testing/fake-platform.js'
import { HiveKeyRotation, HiveKeyRotationAck } from '../hive-key-rotation.js'
import { HiveReport } from '../../report/hive-report.js'

class RotationWorld
{
    public readonly Clock = new FakeClock()
    public readonly Platform = new FakePlatform(this.Clock)
    public readonly Channel = new FakeAgentChannel(this.Platform)

    public async Hive(): Promise<FakeHiveAgent>
    {
        const hive = new FakeHiveAgent(this.Channel, this.Clock)
        await hive.Enrol(this.Platform.IssueHiveCode('acme', HiveLevel.Enrolled), 'acme', HiveLevel.Enrolled)
        return hive
    }

    public static Report(): HiveReport
    {
        return HiveReport.Create({ EngineVersion: '0.10.0', Components: [], Environments: [], Intents: [] })
    }
}

describe('HiveKeyRotation', () =>
{
    it('a rotation is signed by the current key and carries the new one, proved by the new key', async () =>
    {
        const world = new RotationWorld()
        const hive = await world.Hive()
        const before = hive.Key
        const ack = await hive.RotateKey()
        const [rotation] = world.Platform.ReceivedOf<HiveKeyRotation>(MessageKind.HiveKeyRotation)
        assert.ok(rotation !== undefined)
        assert.equal(rotation.PreviousKeyId, before.KeyId)
        assert.ok(rotation.NewPublicKey.Equals(hive.Key.PublicKey))
        assert.ok(rotation.Proven)
        const sent = world.Channel.Wire.find(entry => entry.Text.includes(MessageKind.HiveKeyRotation))
        assert.ok(sent !== undefined && JSON.parse(sent.Text).KeyId === before.KeyId)
        assert.equal(ack.KeyId, hive.Key.KeyId)
        assert.ok(world.Channel.Wire.every(entry => !entry.Text.includes('PRIVATE KEY')))
    })

    it('a proof made by another key, or for another hive, does not prove the rotation', () =>
    {
        const next = SigningKeyPair.Generate()
        const good = HiveKeyRotation.Create('hv0000000001', 'k-old', next).ToJson()
        assert.ok(HiveKeyRotation.Parse(good).Proven)
        assert.equal(HiveKeyRotation.Parse({ ...good, HiveId: 'hv0000000002' }).Proven, false)
        assert.equal(HiveKeyRotation.Parse({ ...good, NewPublicKey: SigningKeyPair.Generate().PublicKey.ToJson() }).Proven, false)
        const same = HiveKeyRotation.Create('hv0000000001', next.KeyId, next)
        assert.equal(same.Proven, false)
        assert.deepEqual(HiveKeyRotationAck.Parse(HiveKeyRotationAck.Create('hv0000000001', next.KeyId).ToJson()).ToJson(), { HiveId: 'hv0000000001', KeyId: next.KeyId })
    })

    it('the fake platform switches the hive\'s key and refuses the old one afterwards', async () =>
    {
        const world = new RotationWorld()
        const hive = await world.Hive()
        const old = hive.Key
        await hive.RotateKey()
        assert.ok(world.Platform.Record(hive.Self)?.PublicKey.Equals(hive.Key.PublicKey))
        await hive.Report(RotationWorld.Report())
        const stale = new EnvelopeSigner(old, hive.Self, world.Clock).Sign(MessageKind.HiveReport, Participant.Platform, RotationWorld.Report())
        await assert.rejects(world.Platform.Handle(stale), (error: unknown) => error instanceof ProtocolVerificationError && error.Failure === VerificationFailure.KeyMismatch)
    })

    it('a rotation whose acknowledgement was lost is acknowledged again when re-sent under the previous key', async () =>
    {
        const world = new RotationWorld()
        const hive = await world.Hive()
        const old = hive.Key
        const next = SigningKeyPair.Generate()
        const signer = new EnvelopeSigner(old, hive.Self, world.Clock)
        const first = await world.Platform.Handle(signer.Sign(MessageKind.HiveKeyRotation, Participant.Platform, HiveKeyRotation.Create(hive.Self.Id, old.KeyId, next)))
        assert.ok(first !== null)
        const again = await world.Platform.Handle(signer.Sign(MessageKind.HiveKeyRotation, Participant.Platform, HiveKeyRotation.Create(hive.Self.Id, old.KeyId, next)))
        assert.ok(again !== null)
        const ack = (await hive.Verifier().Verify(again, MessageKind.HiveKeyRotationAck, HiveKeyRotationAck)).Body
        assert.equal(ack.KeyId, next.KeyId)
        const other = signer.Sign(MessageKind.HiveKeyRotation, Participant.Platform, HiveKeyRotation.Create(hive.Self.Id, old.KeyId, SigningKeyPair.Generate()))
        await assert.rejects(world.Platform.Handle(other), (error: unknown) => error instanceof FakePlatformRefusalError && error.Refusal === FakePlatformRefusal.RotationRefused)
        await assert.rejects(world.Platform.Handle(new EnvelopeSigner(old, hive.Self, world.Clock).Sign(MessageKind.HiveReport, Participant.Platform, RotationWorld.Report())), ProtocolVerificationError)
    })

    it('a rotation naming another hive is refused and the key stays', async () =>
    {
        const world = new RotationWorld()
        const hive = await world.Hive()
        const other = await world.Hive()
        const body = HiveKeyRotation.Create(other.Self.Id, hive.Key.KeyId, SigningKeyPair.Generate())
        await assert.rejects(hive.Send(MessageKind.HiveKeyRotation, body), (error: unknown) => error instanceof FakePlatformRefusalError && error.Refusal === FakePlatformRefusal.RotationRefused)
        assert.ok(world.Platform.Record(hive.Self)?.PublicKey.Equals(hive.Key.PublicKey))
    })

    it('a host may not sign it, and only the platform signs the acknowledgement', () =>
    {
        const clock = new FakeClock()
        const key = SigningKeyPair.Generate()
        const host = new EnvelopeSigner(key, Participant.Host('host-1'), clock)
        assert.throws(() => host.Sign(MessageKind.HiveKeyRotation, Participant.Platform, HiveKeyRotation.Create('host-1', key.KeyId, SigningKeyPair.Generate())), EnvelopeSigningError)
        const hive = new EnvelopeSigner(key, Participant.Hive('hv0000000001'), clock)
        assert.throws(() => hive.Sign(MessageKind.HiveKeyRotationAck, Participant.Platform, HiveKeyRotationAck.Create('hv0000000001', key.KeyId)), EnvelopeSigningError)
    })
})
