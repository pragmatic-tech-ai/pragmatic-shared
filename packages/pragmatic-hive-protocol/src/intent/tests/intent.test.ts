import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SigningKeyPair } from '../../crypto/signing-key.js'
import { ProtocolDecodeError } from '../../wire/protocol-decode-error.js'
import { HiveLevel } from '../../hive/hive-level.js'
import {
    ComponentAtVersion, ConfigurationReference, CreateEnvironment, DeleteEnvironment, EnvironmentPurpose, IntentActionKind, IntentActions, Repair, RepairScope, Rotate,
    RotationSubject, UpdateEnvironment,
} from '../intent-action.js'
import { Intent, IntentAdmission, IntentApplyMode, IntentNotAcceptedError } from '../intent.js'
import { RealmSubject } from '../intent-decision.js'
import { Pull, PullBatch } from '../pull.js'

class Samples
{
    public static readonly Digest = 'sha256:' + 'a'.repeat(64)
    public static readonly Descriptor = 'sha256:' + 'b'.repeat(64)

    public static Component(): ComponentAtVersion
    {
        return new ComponentAtVersion('tenant-admin', '0.10.0', Samples.Digest, Samples.Descriptor, new ConfigurationReference('acme', 3))
    }
}

describe('IntentActions', () =>
{
    it('round-trips every action kind through its closed shape', () =>
    {
        const actions = [
            Samples.Component(),
            new ComponentAtVersion('pragmatic-postgres', '16.4.0', Samples.Digest, Samples.Descriptor, null),
            new CreateEnvironment('staging', EnvironmentPurpose.Development, null),
            new CreateEnvironment('prod', EnvironmentPurpose.Runtime, '1.2.0'),
            new UpdateEnvironment('prod', '1.3.0'),
            new DeleteEnvironment('staging'),
            new Rotate(RotationSubject.HiveKey, null),
            new Rotate(RotationSubject.TrustRoot, SigningKeyPair.Generate().PublicKey),
            new Repair(RepairScope.Engine, null),
            new Repair(RepairScope.Environment, 'prod'),
        ]
        for (const action of actions)
        {
            const json = JSON.parse(JSON.stringify(action.ToJson()))
            assert.deepEqual(IntentActions.Parse(json, 'action').ToJson(), json)
        }
        assert.deepEqual(new Set(actions.map(action => action.Kind)), new Set(IntentActions.Kinds))
    })

    it('refuses members of another kind, unknown kinds and broken digests', () =>
    {
        const component = Samples.Component().ToJson()
        assert.throws(() => IntentActions.Parse({ ...component, Environment: 'prod' }, 'action'), ProtocolDecodeError)
        assert.throws(() => IntentActions.Parse({ ...component, Kind: 'run-shell' }, 'action'), ProtocolDecodeError)
        assert.throws(() => IntentActions.Parse({ ...component, ImageDigest: 'latest' }, 'action'), ProtocolDecodeError)
        assert.throws(() => IntentActions.Parse({ ...component, Configuration: { Realm: 'acme', Version: 0 } }, 'action'), ProtocolDecodeError)
        assert.throws(() => IntentActions.Parse({ Kind: IntentActionKind.UpdateEnvironment, Environment: 'prod', Version: null }, 'action'), ProtocolDecodeError)
    })

    it('ties a rotation\'s new trust root and a repair\'s name to their subject and scope', () =>
    {
        const key = SigningKeyPair.Generate().PublicKey.Raw
        assert.throws(() => IntentActions.Parse({ Kind: 'rotate', Subject: 'trust-root', NewTrustRoot: null }, 'action'), ProtocolDecodeError)
        assert.throws(() => IntentActions.Parse({ Kind: 'rotate', Subject: 'hive-key', NewTrustRoot: key }, 'action'), ProtocolDecodeError)
        assert.throws(() => IntentActions.Parse({ Kind: 'repair', Scope: 'engine', Name: 'x' }, 'action'), ProtocolDecodeError)
        assert.throws(() => IntentActions.Parse({ Kind: 'repair', Scope: 'component', Name: null }, 'action'), ProtocolDecodeError)
    })
})

describe('Intent', () =>
{
    it('is issued under Enrolled or Delegated only', () =>
    {
        assert.equal(Intent.Create('i-1', HiveLevel.Enrolled, Samples.Component()).RequiresApproval, true)
        assert.equal(Intent.Create('i-1', HiveLevel.Delegated, Samples.Component()).RequiresApproval, false)
        assert.throws(() => Intent.Create('i-1', HiveLevel.Hosted, Samples.Component()), ProtocolDecodeError)
        assert.throws(() => Intent.Create('i-1', HiveLevel.Standalone, Samples.Component()), ProtocolDecodeError)
    })
})

describe('IntentAdmission', () =>
{
    it('applies directly only when both the hive and the intent are Delegated; the stricter level wins', () =>
    {
        const delegated = Intent.Create('i-1', HiveLevel.Delegated, Samples.Component())
        const enrolled = Intent.Create('i-2', HiveLevel.Enrolled, Samples.Component())
        assert.equal(new IntentAdmission(HiveLevel.Delegated).ModeFor(delegated), IntentApplyMode.ApplyDirectly)
        assert.equal(new IntentAdmission(HiveLevel.Delegated).ModeFor(enrolled), IntentApplyMode.AwaitApproval)
        assert.equal(new IntentAdmission(HiveLevel.Enrolled).ModeFor(delegated), IntentApplyMode.AwaitApproval)
        assert.equal(new IntentAdmission(HiveLevel.Enrolled).ModeFor(enrolled), IntentApplyMode.AwaitApproval)
    })

    it('takes no intents at Standalone or Hosted', () =>
    {
        const intent = Intent.Create('i-1', HiveLevel.Delegated, Samples.Component())
        assert.throws(() => new IntentAdmission(HiveLevel.Hosted).ModeFor(intent), IntentNotAcceptedError)
        assert.throws(() => new IntentAdmission(HiveLevel.Standalone).ModeFor(intent), IntentNotAcceptedError)
    })
})

describe('RealmSubject', () =>
{
    it('is a realm id and a subject, never a name with spaces', () =>
    {
        assert.equal(RealmSubject.Of('acme', 'u-123|google').Subject, 'u-123|google')
        assert.throws(() => RealmSubject.Of('acme', 'Jane Doe'), ProtocolDecodeError)
        assert.throws(() => RealmSubject.Parse({ Realm: 'acme', Subject: 'u1', Email: 'jane@acme.com' }), ProtocolDecodeError)
    })
})

describe('Pull and PullBatch', () =>
{
    it('bound the cursor and the batch size', () =>
    {
        assert.equal(Pull.Create(5).Max, Pull.MaxItems)
        assert.throws(() => Pull.Create(-1), ProtocolDecodeError)
        assert.throws(() => Pull.Create(0, Pull.MaxItems + 1), ProtocolDecodeError)
        assert.deepEqual(PullBatch.Parse({ Items: [], Cursor: 0 }).Items, [])
        assert.throws(() => PullBatch.Parse({ Items: [{}], Cursor: 0 }), ProtocolDecodeError)
    })
})
