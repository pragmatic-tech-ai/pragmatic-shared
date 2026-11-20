import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SigningKeyPair, SigningPublicKey } from '../../crypto/signing-key.js'
import { ProtocolDecodeError } from '../../wire/protocol-decode-error.js'
import { StrictFields } from '../../wire/strict-fields.js'
import { ProtocolNames } from '../../wire/protocol-names.js'
import { EnvelopeSigner, EnvelopeSigningError } from '../envelope-signer.js'
import { EnvelopeVerifier, KeyDirectory } from '../envelope-verifier.js'
import { FreshnessPolicy, MessageKind } from '../message-kind.js'
import { InMemoryNonceLedger } from '../nonce-ledger.js'
import { Participant, ParticipantRole } from '../participant.js'
import type { IProtocolClock } from '../protocol-clock.js'
import { ProtocolVerificationError, VerificationFailure } from '../protocol-verification-error.js'
import { SignedEnvelope } from '../signed-envelope.js'

class TestClock implements IProtocolClock
{
    public Time = Date.parse('2026-11-20T10:00:00.000Z')

    public Now(): Date
    {
        return new Date(this.Time)
    }
}

/** A stand-in body: one label. */
class LabelBody
{
    public constructor(public readonly Name: string)
    {
    }

    public static Parse(value: unknown, path: string): LabelBody
    {
        return new LabelBody(StrictFields.Exactly(value, ['Name'], path).String('Name', { Pattern: ProtocolNames.Label }))
    }

    public ToJson(): { Name: string }
    {
        return { Name: this.Name }
    }
}

/** A stand-in self-signed body: the key it enrols. */
class KeyBody
{
    public constructor(public readonly Key: string)
    {
    }

    public static Parse(value: unknown, path: string): KeyBody
    {
        return new KeyBody(StrictFields.Exactly(value, ['Key'], path).String('Key', {}))
    }

    public ToJson(): { Key: string }
    {
        return { Key: this.Key }
    }
}

class Rig
{
    public readonly Clock = new TestClock()
    public readonly HiveKey = SigningKeyPair.Generate()
    public readonly Hive = Participant.Hive('hive-1')
    public readonly Keys = new KeyDirectory().Add(this.Hive, this.HiveKey.PublicKey)
    public readonly Signer = new EnvelopeSigner(this.HiveKey, this.Hive, this.Clock)
    public readonly Verifier = new EnvelopeVerifier({ Self: Participant.Platform, Keys: this.Keys, Nonces: new InMemoryNonceLedger(this.Clock), Clock: this.Clock })

    public Report(name: string = 'ok'): SignedEnvelope
    {
        return this.Signer.Sign(MessageKind.HiveReport, Participant.Platform, new LabelBody(name))
    }

    public async Refused(envelope: SignedEnvelope, failure: VerificationFailure, kind: MessageKind = MessageKind.HiveReport): Promise<void>
    {
        await assert.rejects(this.Verifier.Verify(envelope, kind, LabelBody), (error: unknown) => error instanceof ProtocolVerificationError && error.Failure === failure)
    }

    /** The envelope with `change` applied to its wire form and re-signed by `key` (default: the hive's). */
    public Resigned(envelope: SignedEnvelope, change: Record<string, unknown>, key: SigningKeyPair = this.HiveKey): SignedEnvelope
    {
        const { Signature: _signature, ...unsigned } = { ...envelope.ToJson(), ...change }
        const signature = key.Sign(SignedEnvelope.SigningInput(unsigned as never)).toString('base64url')
        return SignedEnvelope.Parse({ ...unsigned, Signature: signature })
    }
}

describe('SignedEnvelope', () =>
{
    it('round-trips through its wire text and names itself by digest', () =>
    {
        const rig = new Rig()
        const envelope = rig.Report()
        const again = SignedEnvelope.Decode(envelope.Encode())
        assert.deepEqual(again.ToJson(), envelope.ToJson())
        assert.equal(again.Digest, envelope.Digest)
        assert.match(envelope.Digest, ProtocolNames.Digest)
        assert.equal(envelope.IssuedAt.toISOString(), '2026-11-20T10:00:00.000Z')
        assert.equal(envelope.ExpiresAt.getTime() - envelope.IssuedAt.getTime(), FreshnessPolicy.Exchange.DefaultLifetimeMs)
    })

    it('decodes strictly: unknown members, another protocol, fractions in the body, expiry before issue', () =>
    {
        const json = new Rig().Report().ToJson()
        assert.throws(() => SignedEnvelope.Parse({ ...json, Extra: 1 }), ProtocolDecodeError)
        assert.throws(() => SignedEnvelope.Parse({ ...json, Protocol: 2 }), ProtocolDecodeError)
        assert.throws(() => SignedEnvelope.Parse({ ...json, Kind: 'hive.logs' }), ProtocolDecodeError)
        assert.throws(() => SignedEnvelope.Parse({ ...json, Body: { Name: 0.5 } }), ProtocolDecodeError)
        assert.throws(() => SignedEnvelope.Parse({ ...json, Body: [] }), ProtocolDecodeError)
        assert.throws(() => SignedEnvelope.Parse({ ...json, ExpiresAt: json.IssuedAt }), ProtocolDecodeError)
        assert.throws(() => SignedEnvelope.Parse({ ...json, Issuer: { Role: 'platform', Id: 'evil' } }), ProtocolDecodeError)
        assert.throws(() => SignedEnvelope.Decode('x'.repeat(SignedEnvelope.MaxBytes + 1)), ProtocolDecodeError)
    })
})

describe('EnvelopeSigner', () =>
{
    it('refuses a kind its role may not sign, an audience the kind is not for, or a lifetime beyond the kind', () =>
    {
        const rig = new Rig()
        assert.throws(() => rig.Signer.Sign(MessageKind.Intent, Participant.Hive('hive-2'), new LabelBody('x')), EnvelopeSigningError)
        assert.throws(() => rig.Signer.Sign(MessageKind.HiveReport, Participant.Hive('hive-2'), new LabelBody('x')), EnvelopeSigningError)
        assert.throws(() => rig.Signer.Sign(MessageKind.HiveReport, Participant.Platform, new LabelBody('x'), FreshnessPolicy.Exchange.MaxLifetimeMs + 1), EnvelopeSigningError)
        assert.throws(() => rig.Signer.Sign(MessageKind.HiveReport, Participant.Platform, new LabelBody('x'), 0), EnvelopeSigningError)
    })

    it('draws a fresh nonce for every message', () =>
    {
        const rig = new Rig()
        assert.notEqual(rig.Report().Nonce, rig.Report().Nonce)
    })
})

describe('EnvelopeVerifier', () =>
{
    it('accepts a fresh, signed, addressed message once and decodes its body', async () =>
    {
        const rig = new Rig()
        const envelope = rig.Report('fine')
        const verified = await rig.Verifier.Verify(SignedEnvelope.Decode(envelope.Encode()), MessageKind.HiveReport, LabelBody)
        assert.equal(verified.Body.Name, 'fine')
        assert.ok(verified.Issuer.Equals(rig.Hive))
        await rig.Refused(envelope, VerificationFailure.Replayed)
    })

    it('refuses another kind, another audience, an unknown issuer and a foreign key', async () =>
    {
        const rig = new Rig()
        await rig.Refused(rig.Report(), VerificationFailure.WrongKind, MessageKind.IntentDecision)
        await rig.Refused(rig.Resigned(rig.Report(), { Audience: Participant.Hive('hive-1').ToJson() }), VerificationFailure.WrongAudience)
        const stranger = new EnvelopeSigner(SigningKeyPair.Generate(), Participant.Hive('hive-9'), rig.Clock)
        await rig.Refused(stranger.Sign(MessageKind.HiveReport, Participant.Platform, new LabelBody('x')), VerificationFailure.UnknownIssuer)
        const impostor = new EnvelopeSigner(SigningKeyPair.Generate(), rig.Hive, rig.Clock)
        await rig.Refused(impostor.Sign(MessageKind.HiveReport, Participant.Platform, new LabelBody('x')), VerificationFailure.KeyMismatch)
        const other = SigningKeyPair.Generate()
        await rig.Refused(rig.Resigned(rig.Report(), { KeyId: rig.HiveKey.KeyId }, other), VerificationFailure.BadSignature)
    })

    it('refuses a role that may not sign the kind (a hive posing as the platform issuing an intent)', async () =>
    {
        const rig = new Rig()
        const hiveVerifier = new EnvelopeVerifier({ Self: rig.Hive, Keys: rig.Keys, Nonces: new InMemoryNonceLedger(rig.Clock), Clock: rig.Clock })
        const forged = rig.Resigned(rig.Report(), { Kind: MessageKind.Intent, Audience: rig.Hive.ToJson() })
        await assert.rejects(hiveVerifier.Verify(forged, MessageKind.Intent, LabelBody), (error: unknown) => error instanceof ProtocolVerificationError && error.Failure === VerificationFailure.WrongIssuer)
    })

    it('refuses any change to a signed member', async () =>
    {
        const rig = new Rig()
        const json = rig.Report('one').ToJson()
        for (const change of [{ Body: { Name: 'two' } }, { Nonce: 'A'.repeat(22) }, { ExpiresAt: '2026-11-20T10:03:00.000Z' }])
        {
            await rig.Refused(SignedEnvelope.Parse({ ...json, ...change }), VerificationFailure.BadSignature)
        }
    })

    it('enforces the freshness window: skew, expiry and the kind\'s longest lifetime', async () =>
    {
        const rig = new Rig()
        const early = rig.Report()
        rig.Clock.Time -= FreshnessPolicy.Exchange.MaxSkewMs + 1
        await rig.Refused(early, VerificationFailure.NotYetValid)
        rig.Clock.Time += FreshnessPolicy.Exchange.MaxSkewMs + 1
        const late = rig.Report()
        rig.Clock.Time += FreshnessPolicy.Exchange.DefaultLifetimeMs + FreshnessPolicy.Exchange.MaxSkewMs + 1
        await rig.Refused(late, VerificationFailure.Expired)
        const long = rig.Resigned(rig.Report(), { ExpiresAt: new Date(rig.Clock.Time + FreshnessPolicy.Exchange.MaxLifetimeMs + 1).toISOString() })
        await rig.Refused(long, VerificationFailure.LifetimeTooLong)
    })

    it('tolerates skew within the window', async () =>
    {
        const rig = new Rig()
        const envelope = rig.Report()
        rig.Clock.Time -= FreshnessPolicy.Exchange.MaxSkewMs
        assert.equal((await rig.Verifier.Verify(envelope, MessageKind.HiveReport, LabelBody)).Body.Name, 'ok')
    })

    it('refuses a malformed body after the signature checks, keeping the shape error', async () =>
    {
        const rig = new Rig()
        const envelope = rig.Signer.Sign(MessageKind.HiveReport, Participant.Platform, { ToJson: () => ({ Name: 'x', Logs: 'stack trace' }) })
        await assert.rejects(rig.Verifier.Verify(envelope, MessageKind.HiveReport, LabelBody), (error: unknown) =>
            error instanceof ProtocolVerificationError && error.Failure === VerificationFailure.Malformed && error.Decode?.Path === 'message.Body.Logs')
    })

    it('verifies a self-signed enrolment request by the key in its body, and only that one', async () =>
    {
        const rig = new Rig()
        const key = SigningKeyPair.Generate()
        const signer = EnvelopeSigner.SelfSigned(key, ParticipantRole.Hive, rig.Clock)
        const request = signer.Sign(MessageKind.HiveEnrolmentRequest, Participant.Platform, new KeyBody(key.PublicKey.Raw))
        const verified = await rig.Verifier.VerifySelfSigned(request, MessageKind.HiveEnrolmentRequest, KeyBody, body => SigningPublicKey.Parse(body.Key))
        assert.equal(verified.Issuer.Id, key.KeyId)
        const swapped = signer.Sign(MessageKind.HiveEnrolmentRequest, Participant.Platform, new KeyBody(SigningKeyPair.Generate().PublicKey.Raw))
        await assert.rejects(rig.Verifier.VerifySelfSigned(swapped, MessageKind.HiveEnrolmentRequest, KeyBody, body => SigningPublicKey.Parse(body.Key)), ProtocolVerificationError)
        await assert.rejects(rig.Verifier.Verify(request, MessageKind.HiveEnrolmentRequest, KeyBody), ProtocolVerificationError)
    })

    it('rechecks a kept standing message without claiming its nonce again, still refusing it once expired', async () =>
    {
        const rig = new Rig()
        const platformKey = SigningKeyPair.Generate()
        const platform = new EnvelopeSigner(platformKey, Participant.Platform, rig.Clock)
        const hiveVerifier = new EnvelopeVerifier({ Self: rig.Hive, Keys: new KeyDirectory().Add(Participant.Platform, platformKey.PublicKey), Nonces: new InMemoryNonceLedger(rig.Clock), Clock: rig.Clock })
        const intent = platform.Sign(MessageKind.Intent, rig.Hive, new LabelBody('i1'), 86_400_000)
        await hiveVerifier.Verify(intent, MessageKind.Intent, LabelBody)
        rig.Clock.Time += 3_600_000
        assert.equal((await hiveVerifier.Recheck(intent, MessageKind.Intent, LabelBody)).Body.Name, 'i1')
        rig.Clock.Time += 86_400_000
        await assert.rejects(hiveVerifier.Recheck(intent, MessageKind.Intent, LabelBody), (error: unknown) => error instanceof ProtocolVerificationError && error.Failure === VerificationFailure.Expired)
    })

    it('forgets nonces once their messages can no longer be fresh', async () =>
    {
        const clock = new TestClock()
        const ledger = new InMemoryNonceLedger(clock)
        assert.equal(await ledger.Claim(Participant.Hive('a'), 'n'.repeat(22), new Date(clock.Time + 10)), true)
        assert.equal(await ledger.Claim(Participant.Hive('a'), 'n'.repeat(22), new Date(clock.Time + 10)), false)
        assert.equal(await ledger.Claim(Participant.Hive('b'), 'n'.repeat(22), new Date(clock.Time + 10)), true)
        clock.Time += 11
        assert.equal(await ledger.Claim(Participant.Hive('c'), 'm'.repeat(22), new Date(clock.Time + 10)), true)
        assert.equal(ledger.Size, 1)
    })
})
