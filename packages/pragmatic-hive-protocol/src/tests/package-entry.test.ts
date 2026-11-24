import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as entry from '../index.js'
import * as testing from '../testing/index.js'

test('the package entry exports the codecs, keys, envelope, messages and verifiers', () =>
{
    for (const name of [
        'StrictFields', 'CanonicalJson', 'ProtocolDecodeError', 'SigningKeyPair', 'SigningPublicKey', 'SealingKeyPair', 'SealedBlob',
        'Participant', 'MessageKind', 'SignedEnvelope', 'EnvelopeSigner', 'EnvelopeVerifier', 'KeyDirectory', 'InMemoryNonceLedger',
        'ProtocolVerificationError', 'HiveLevel', 'ConsoleAddress', 'HiveEnrolmentRequest', 'HiveEnrolmentResponse', 'Intent', 'IntentActions',
        'IntentAdmission', 'IntentDecision', 'RealmSubject', 'Pull', 'PullBatch', 'HiveReport', 'HostEnrolmentRequest', 'HostEnrolmentResponse',
        'HostReport', 'PlacementRequest', 'PlacementResult', 'ClusterCredentialHandover', 'TunnelHello', 'TunnelFrames', 'EnrolmentHandshake',
        'AgentExchangeLink', 'AgentExchangeRefusal', 'HttpAgentChannel', 'AgentChannelUnavailableError', 'AgentChannelFailure',
        'AgentInternalLink', 'HiveEnrolmentCall', 'HiveEnrolmentRefusal', 'HiveEnrolmentStatus', 'HiveKeyRotation', 'HiveKeyRotationAck', 'IntentFailure',
        'EnvironmentPurpose', 'IntentInternalLink', 'IntentDecisionCall', 'IntentDecisionRefusal', 'KeptIntentView', 'KeptIntentListing', 'ConsoleIntentLink',
        'ConsoleIntentCall', 'ConsoleIntentOutcome', 'ConsoleIntentRefusal',
    ])
    {
        assert.ok(name in entry, name)
    }
    assert.ok(!('FakePlatform' in entry))
    for (const name of ['FakeClock', 'FakePlatform', 'FakeAgentChannel', 'FakeHiveAgent', 'FakeHostAgent'])
    {
        assert.ok(name in testing, name)
    }
})
