import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SigningKeyPair } from '../../crypto/signing-key.js'
import { ProtocolDecodeError } from '../../wire/protocol-decode-error.js'
import { ConsoleAddress, ConsoleAddressOption } from '../console-address.js'
import { HiveEnrolmentRequest, HiveEnrolmentResponse } from '../hive-enrolment.js'
import { HiveLevel } from '../hive-level.js'

class Samples
{
    public static readonly Code = 'abcdefghijklmnop0123'

    public static Request(): Record<string, unknown>
    {
        return HiveEnrolmentRequest.Create({
            EnrolmentCode: Samples.Code,
            Tenant: 'acme',
            Level: HiveLevel.Enrolled,
            PublicKey: SigningKeyPair.Generate().PublicKey,
            EngineVersion: '0.10.0',
            ConsoleAddress: ConsoleAddress.OwnDomain('pragmatic.acme.com'),
        }).ToJson() as unknown as Record<string, unknown>
    }
}

describe('ConsoleAddress', () =>
{
    it('carries the three options of levels design §6b', () =>
    {
        assert.equal(ConsoleAddress.OwnDomain('pragmatic.acme.com').IngressAddress, null)
        const published = ConsoleAddress.HiveSubdomain('acme', '203.0.113.7')
        assert.equal(published.HostName, 'acme.hives.pragmatic-tech.ai')
        assert.equal(published.IngressAddress, '203.0.113.7')
        assert.equal(ConsoleAddress.RelayedHiveSubdomain('acme').Option, ConsoleAddressOption.RelayedHiveSubdomain)
        assert.deepEqual(ConsoleAddress.Parse(published.ToJson()).ToJson(), published.ToJson())
    })

    it('refuses an option that does not match the name or the ingress address', () =>
    {
        assert.throws(() => ConsoleAddress.OwnDomain('acme.hives.pragmatic-tech.ai'), ProtocolDecodeError)
        assert.throws(() => ConsoleAddress.Parse({ Option: 'hive-subdomain', HostName: 'acme.hives.pragmatic-tech.ai', IngressAddress: null }), ProtocolDecodeError)
        assert.throws(() => ConsoleAddress.Parse({ Option: 'relayed-hive-subdomain', HostName: 'acme.hives.pragmatic-tech.ai', IngressAddress: '10.0.0.1' }), ProtocolDecodeError)
        assert.throws(() => ConsoleAddress.Parse({ Option: 'hive-subdomain', HostName: 'a.b.hives.pragmatic-tech.ai', IngressAddress: '10.0.0.1' }), ProtocolDecodeError)
        assert.throws(() => ConsoleAddress.HiveSubdomain('acme', 'not an address'), ProtocolDecodeError)
        assert.throws(() => ConsoleAddress.Parse({ Option: 'own-domain', HostName: 'pragmatic.acme.com', IngressAddress: null, Port: 443 }), ProtocolDecodeError)
    })
})

describe('HiveEnrolmentRequest', () =>
{
    it('round-trips and names its key for self-signed verification', () =>
    {
        const json = Samples.Request()
        const request = HiveEnrolmentRequest.Parse(json)
        assert.deepEqual(request.ToJson(), json)
        assert.equal(HiveEnrolmentRequest.KeyOf(request).Raw, json.PublicKey)
    })

    it('refuses Standalone, a bad code, tenant, key or version, and unknown members', () =>
    {
        const json = Samples.Request()
        for (const change of [{ Level: HiveLevel.Standalone }, { EnrolmentCode: 'short' }, { Tenant: 'Acme Corp' }, { PublicKey: 'x' }, { EngineVersion: 'latest' }, { Kubeconfig: 'apiVersion: v1' }])
        {
            assert.throws(() => HiveEnrolmentRequest.Parse({ ...json, ...change }), ProtocolDecodeError)
        }
    })
})

describe('HiveEnrolmentResponse', () =>
{
    it('carries the hive id, trust root, channel URL and the answered nonce; https only', () =>
    {
        const root = SigningKeyPair.Generate().PublicKey
        const response = HiveEnrolmentResponse.Create({ HiveId: 'hive-7', Tenant: 'acme', Level: HiveLevel.Delegated, TrustRoot: root, ChannelUrl: 'https://edge.pragmatic-tech.ai/agent/v1', RequestNonce: 'n'.repeat(22) })
        assert.ok(HiveEnrolmentResponse.Parse(response.ToJson()).TrustRoot.Equals(root))
        assert.throws(() => HiveEnrolmentResponse.Parse({ ...response.ToJson(), ChannelUrl: 'http://edge.pragmatic-tech.ai' }), ProtocolDecodeError)
        assert.throws(() => HiveEnrolmentResponse.Parse({ ...response.ToJson(), HiveId: 'Hive 7' }), ProtocolDecodeError)
    })
})
