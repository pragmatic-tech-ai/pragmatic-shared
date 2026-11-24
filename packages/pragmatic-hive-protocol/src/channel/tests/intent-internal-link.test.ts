import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HiveLevel } from '../../hive/hive-level.js'
import {
    ComponentAtVersion, CreateEnvironment, DeleteEnvironment, EnvironmentPurpose, Repair, RepairScope, Rotate, RotationSubject, UpdateEnvironment,
} from '../../intent/intent-action.js'
import { RealmSubject } from '../../intent/intent-decision.js'
import { IntentFailure, IntentProgress, IntentStatus } from '../../report/hive-report.js'
import { ProtocolDecodeError } from '../../wire/protocol-decode-error.js'
import {
    ConsoleIntentCall, ConsoleIntentLink, ConsoleIntentOutcome, ConsoleIntentRefusal, IntentChoice, IntentDecisionCall, IntentDecisionRefusal, IntentInternalLink,
    KeptIntentListing, KeptIntentView,
} from '../intent-internal-link.js'

class LinkSamples
{
    public static readonly Digest = 'sha256:' + 'c'.repeat(64)

    public static View(progress: IntentStatus, expiresAt: Date = new Date('2026-12-01T00:00:00.000Z')): KeptIntentView
    {
        return KeptIntentView.Create({
            IntentId: 'in0000000000ab', IntentDigest: LinkSamples.Digest, Level: HiveLevel.Enrolled, Action: new CreateEnvironment('prod', EnvironmentPurpose.Runtime, null),
            IssuedAt: new Date('2026-11-24T00:00:00.000Z'), ExpiresAt: expiresAt, Status: progress,
        })
    }
}

describe('IntentInternalLink', () =>
{
    it('names the decision path by intent id and reads the id back, refusing anything else', () =>
    {
        assert.equal(IntentInternalLink.DecisionPath('in0000000000ab'), '/internal/intents/in0000000000ab/decision')
        assert.equal(IntentInternalLink.IntentIdOf('/internal/intents/in0000000000ab/decision'), 'in0000000000ab')
        assert.equal(IntentInternalLink.IntentIdOf('/internal/intents/IN%2F/decision'), undefined)
        assert.equal(IntentInternalLink.IntentIdOf('/internal/intents/in1'), undefined)
        assert.equal(IntentInternalLink.IntentIdOf('/internal/enrol'), undefined)
    })

    it('answers every refusal with a code and a status, and reads only its own codes back', () =>
    {
        for (const code of IntentInternalLink.Codes)
        {
            assert.ok(IntentInternalLink.StatusOf(code) >= 400)
            assert.equal(IntentInternalLink.CodeOf(IntentInternalLink.RefusalBody(code)), code)
        }
        assert.equal(IntentInternalLink.StatusOf(IntentDecisionRefusal.Expired), 410)
        assert.equal(IntentInternalLink.CodeOf({ code: 'drop-tables' }), null)
        assert.equal(IntentInternalLink.CodeOf('expired'), null)
    })

    it('a decision call names the digest, the choice and a realm subject, never free text', () =>
    {
        const call = IntentDecisionCall.Create(LinkSamples.Digest, IntentChoice.Reject, RealmSubject.Of('acme', 'u-42'))
        assert.deepEqual(IntentDecisionCall.Parse(JSON.parse(JSON.stringify(call.ToJson()))).ToJson(), call.ToJson())
        assert.throws(() => IntentDecisionCall.Parse({ ...call.ToJson(), Reason: 'no thanks' }), ProtocolDecodeError)
        assert.throws(() => IntentDecisionCall.Parse({ ...call.ToJson(), Approver: { Realm: 'acme', Subject: 'Jane Doe <jane@acme.test>' } }), ProtocolDecodeError)
        assert.throws(() => IntentDecisionCall.Parse({ ...call.ToJson(), IntentDigest: 'latest' }), ProtocolDecodeError)
    })

    it('a kept intent view round-trips, is decidable only while awaiting and unexpired, and a failure needs Failed', () =>
    {
        const now = new Date('2026-11-25T00:00:00.000Z')
        const waiting = LinkSamples.View(IntentStatus.Of('in0000000000ab', IntentProgress.AwaitingApproval))
        assert.deepEqual(KeptIntentView.Parse(JSON.parse(JSON.stringify(waiting.ToJson()))).ToJson(), waiting.ToJson())
        assert.equal(waiting.Decidable(now), true)
        assert.equal(LinkSamples.View(IntentStatus.Of('in0000000000ab', IntentProgress.AwaitingApproval), new Date('2026-11-24T12:00:00.000Z')).Decidable(now), false)
        assert.equal(LinkSamples.View(IntentStatus.Of('in0000000000ab', IntentProgress.Applied)).Decidable(now), false)
        const failed = LinkSamples.View(IntentStatus.FailedWith('in0000000000ab', IntentFailure.EnvironmentExists))
        assert.equal(failed.Failure, IntentFailure.EnvironmentExists)
        assert.throws(() => KeptIntentView.Parse({ ...waiting.ToJson(), Failure: IntentFailure.ApplyFailed }), ProtocolDecodeError)
        const listing = KeptIntentListing.Of([waiting, LinkSamples.View(IntentStatus.Of('in0000000000ab', IntentProgress.Applied))].slice(0, 1))
        assert.deepEqual(KeptIntentListing.Parse(listing.ToJson()).ToJson(), listing.ToJson())
        assert.throws(() => KeptIntentListing.Parse({ Intents: [waiting.ToJson(), waiting.ToJson()] }), ProtocolDecodeError)
    })
})

describe('ConsoleIntentLink', () =>
{
    it('forwards the environment kinds, an environment repair and the ingress rotation, and nothing else', () =>
    {
        const forwarded = [
            new CreateEnvironment('prod', EnvironmentPurpose.Runtime, '1.2.0'), new UpdateEnvironment('prod', '1.3.0'), new DeleteEnvironment('prod'),
            new Repair(RepairScope.Environment, 'prod'), new Rotate(RotationSubject.IngressCertificate, null),
        ]
        for (const action of forwarded)
        {
            assert.equal(ConsoleIntentCall.Forwards(action), true, action.Kind)
            const call = ConsoleIntentCall.Create('in0000000000ab', action)
            assert.deepEqual(ConsoleIntentCall.Parse(JSON.parse(JSON.stringify(call.ToJson()))).ToJson(), call.ToJson())
        }
        const kept = [
            new ComponentAtVersion('pragmatic-tenant-admin', '0.1.13', 'sha256:' + 'a'.repeat(64), 'sha256:' + 'b'.repeat(64), null),
            new Repair(RepairScope.Engine, null), new Repair(RepairScope.Component, 'pragmatic-tenant-admin'), new Rotate(RotationSubject.HiveKey, null),
        ]
        for (const action of kept)
        {
            assert.equal(ConsoleIntentCall.Forwards(action), false, action.Kind)
            assert.throws(() => ConsoleIntentCall.Parse({ IntentId: 'in0000000000ab', Action: action.ToJson() }), ProtocolDecodeError)
        }
    })

    it('an outcome is applied, or failed with a code; the refusals have their statuses', () =>
    {
        assert.equal(ConsoleIntentOutcome.Parse({ Progress: IntentProgress.Applied, Failure: null }), ConsoleIntentOutcome.Applied)
        const failed = ConsoleIntentOutcome.FailedWith(IntentFailure.EnvironmentNotFound)
        assert.deepEqual(failed.StatusOf('in0000000000ab').ToJson(), { IntentId: 'in0000000000ab', Progress: IntentProgress.Failed, Failure: IntentFailure.EnvironmentNotFound })
        assert.throws(() => ConsoleIntentOutcome.Parse({ Progress: IntentProgress.Applying, Failure: null }), ProtocolDecodeError)
        assert.throws(() => ConsoleIntentOutcome.Parse({ Progress: IntentProgress.Failed, Failure: null }), ProtocolDecodeError)
        assert.equal(ConsoleIntentLink.StatusOf(ConsoleIntentRefusal.NotAgent), 403)
        assert.equal(ConsoleIntentLink.CodeOf(ConsoleIntentLink.RefusalBody(ConsoleIntentRefusal.Unavailable)), ConsoleIntentRefusal.Unavailable)
        assert.equal(ConsoleIntentLink.Port, 7211)
        assert.equal(ConsoleIntentLink.Path, '/internal/environment-intents')
    })
})
