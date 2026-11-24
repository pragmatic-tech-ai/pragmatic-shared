import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { SigningKeyPair } from '../../crypto/signing-key.js'
import { EnvelopeSigner, EnvelopeSigningError } from '../../envelope/envelope-signer.js'
import { EnvelopeVerifier, KeyDirectory } from '../../envelope/envelope-verifier.js'
import { MessageKind } from '../../envelope/message-kind.js'
import { InMemoryNonceLedger } from '../../envelope/nonce-ledger.js'
import { Participant } from '../../envelope/participant.js'
import { ProtocolVerificationError, VerificationFailure } from '../../envelope/protocol-verification-error.js'
import { SignedEnvelope } from '../../envelope/signed-envelope.js'
import { HiveLevel } from '../../hive/hive-level.js'
import { FakeAgentChannel } from '../../testing/fake-agent-channel.js'
import { FakeHiveAgent, FakeHostAgent } from '../../testing/fake-agents.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { FakePlatform } from '../../testing/fake-platform.js'
import { DecodeReason, ProtocolDecodeError } from '../../wire/protocol-decode-error.js'
import { ServiceAccountKeys, ServiceAccountKeyType } from '../service-account-keys.js'

class Jwks
{
    public static readonly Issuer = 'https://agent.pragmatic-tech.ai/hives/acme-1/sa'

    /** A key as a Kubernetes API server publishes it at /openid/v1/jwks. */
    public static Rsa(kid: string = 'rsa-1'): Record<string, unknown>
    {
        const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
        const jwk = publicKey.export({ format: 'jwk' }) as { n: string, e: string }
        return { use: 'sig', kty: 'RSA', kid, alg: 'RS256', n: jwk.n, e: jwk.e }
    }

    public static Ec(kid: string = 'ec-1'): Record<string, unknown>
    {
        const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
        const jwk = publicKey.export({ format: 'jwk' }) as { x: string, y: string }
        return { use: 'sig', kty: 'EC', kid, alg: 'ES256', crv: 'P-256', x: jwk.x, y: jwk.y }
    }

    /** A private key exported as a JWK: what a careless reporter could send. */
    public static PrivateRsa(): Record<string, unknown>
    {
        const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
        return { use: 'sig', kid: 'leak', alg: 'RS256', ...(privateKey.export({ format: 'jwk' }) as Record<string, unknown>) }
    }
}

describe('ServiceAccountKeys', () =>
{
    it('carries the issuer and its public RSA and EC keys, and serves them as a JWKS', () =>
    {
        const keys = ServiceAccountKeys.Create({ Issuer: Jwks.Issuer, Keys: [Jwks.Rsa(), Jwks.Ec()] })
        const again = ServiceAccountKeys.Parse(JSON.parse(JSON.stringify(keys.ToJson())))
        assert.deepEqual(again.ToJson(), keys.ToJson())
        assert.deepEqual(again.Keys.map(key => key.Type), [ServiceAccountKeyType.Rsa, ServiceAccountKeyType.Ec])
        assert.deepEqual(again.Jwks().keys.map(key => key.kid), ['rsa-1', 'ec-1'])
    })

    it('refuses a JWKS with a private member at decode, naming the member', () =>
    {
        assert.throws(() => ServiceAccountKeys.Create({ Issuer: Jwks.Issuer, Keys: [Jwks.PrivateRsa()] }), (error: unknown) =>
            error instanceof ProtocolDecodeError && error.Reason === DecodeReason.PrivateKeyMaterial && error.Path === 'message.Keys[0].d')
        for (const member of ['p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'])
        {
            assert.throws(() => ServiceAccountKeys.Create({ Issuer: Jwks.Issuer, Keys: [{ ...Jwks.Ec(), [member]: 'AQAB' }] }), (error: unknown) => error instanceof ProtocolDecodeError && error.Reason === DecodeReason.PrivateKeyMaterial)
        }
        assert.throws(() => ServiceAccountKeys.Create({ Issuer: Jwks.Issuer, Keys: [{ kty: 'oct', kid: 'k', use: 'sig', alg: 'HS256', k: 'c2VjcmV0' }] }), (error: unknown) => error instanceof ProtocolDecodeError && error.Reason === DecodeReason.PrivateKeyMaterial)
    })

    it('bounds the set: at most 8 keys, each at most 4 KiB, unique ids, a closed shape, an https issuer', () =>
    {
        const nine = Array.from({ length: ServiceAccountKeys.MaxKeys + 1 }, (_, index) => Jwks.Ec('ec-' + index))
        assert.throws(() => ServiceAccountKeys.Create({ Issuer: Jwks.Issuer, Keys: nine }), ProtocolDecodeError)
        assert.equal(ServiceAccountKeys.Create({ Issuer: Jwks.Issuer, Keys: nine.slice(1) }).Keys.length, ServiceAccountKeys.MaxKeys)
        assert.throws(() => ServiceAccountKeys.Create({ Issuer: Jwks.Issuer, Keys: [{ ...Jwks.Rsa(), n: 'A'.repeat(5000) }] }), (error: unknown) => error instanceof ProtocolDecodeError && error.Reason === DecodeReason.TooLarge)
        assert.throws(() => ServiceAccountKeys.Create({ Issuer: Jwks.Issuer, Keys: [Jwks.Ec('same'), Jwks.Ec('same')] }), ProtocolDecodeError)
        assert.throws(() => ServiceAccountKeys.Create({ Issuer: Jwks.Issuer, Keys: [{ ...Jwks.Rsa(), x5c: ['MII...'] }] }), ProtocolDecodeError)
        assert.throws(() => ServiceAccountKeys.Create({ Issuer: Jwks.Issuer, Keys: [{ ...Jwks.Rsa(), use: 'enc' }] }), ProtocolDecodeError)
        assert.throws(() => ServiceAccountKeys.Create({ Issuer: Jwks.Issuer, Keys: [] }), ProtocolDecodeError)
        assert.throws(() => ServiceAccountKeys.Create({ Issuer: 'http://agent.pragmatic-tech.ai/hives/acme-1/sa', Keys: [Jwks.Ec()] }), ProtocolDecodeError)
    })
})

describe('service-account keys on the agent channel', () =>
{
    it('a hive signs its issuer keys and the platform takes them from it', async () =>
    {
        const clock = new FakeClock()
        const platform = new FakePlatform(clock)
        const channel = new FakeAgentChannel(platform)
        const hive = new FakeHiveAgent(channel, clock)
        await hive.Enrol(platform.IssueHiveCode('acme', HiveLevel.Enrolled), 'acme', HiveLevel.Enrolled)
        await hive.ReportServiceAccountKeys(ServiceAccountKeys.Create({ Issuer: Jwks.Issuer, Keys: [Jwks.Rsa()] }))
        const received = platform.Received.filter(message => message.Kind === MessageKind.ServiceAccountKeys)
        assert.equal(received.length, 1)
        assert.equal(received[0]!.Issuer.Key, hive.Self.Key)
        assert.equal((received[0]!.Body as ServiceAccountKeys).Issuer, Jwks.Issuer)
    })

    it('only a hive may sign it: a host agent cannot send it, and a host-signed one is refused', async () =>
    {
        const clock = new FakeClock()
        const platform = new FakePlatform(clock)
        const host = new FakeHostAgent(new FakeAgentChannel(platform), clock)
        await host.Enrol(platform.IssueHostCode(), 'hive-laptop')
        const keys = ServiceAccountKeys.Create({ Issuer: Jwks.Issuer, Keys: [Jwks.Ec()] })
        await assert.rejects(host.Send(MessageKind.ServiceAccountKeys, keys), EnvelopeSigningError)

        // Forged: a host key signing the kind directly, past its own signer's checks.
        const hostKey = SigningKeyPair.Generate()
        const hostSelf = Participant.Host('host-1')
        const verifier = new EnvelopeVerifier({ Self: Participant.Platform, Keys: new KeyDirectory().Add(hostSelf, hostKey.PublicKey), Nonces: new InMemoryNonceLedger(clock), Clock: clock })
        const honest = new EnvelopeSigner(hostKey, hostSelf, clock).Sign(MessageKind.HostReport, Participant.Platform, keys)
        const { Signature: _signature, ...unsigned } = { ...honest.ToJson(), Kind: MessageKind.ServiceAccountKeys }
        const forged = SignedEnvelope.Parse({ ...unsigned, Signature: hostKey.Sign(SignedEnvelope.SigningInput(unsigned as never)).toString('base64url') })
        await assert.rejects(verifier.Verify(forged, MessageKind.ServiceAccountKeys, ServiceAccountKeys), (error: unknown) => error instanceof ProtocolVerificationError && error.Failure === VerificationFailure.WrongIssuer)
    })
})
