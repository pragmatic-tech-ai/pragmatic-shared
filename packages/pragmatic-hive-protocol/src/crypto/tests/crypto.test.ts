import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { inspect } from 'node:util'
import { CurveKeyType, KeyEncoding } from '../key-encoding.js'
import { SealedBlob, SealedBlobError } from '../sealed-blob.js'
import { SealingKeyPair, SealingPublicKey } from '../sealing-key.js'
import { SigningKeyError, SigningKeyPair, SigningPublicKey } from '../signing-key.js'
import { ProtocolDecodeError } from '../../wire/protocol-decode-error.js'

describe('SigningKeyPair', () =>
{
    it('signs with Ed25519 and verifies through the public half on the wire', () =>
    {
        const pair = SigningKeyPair.Generate()
        const data = Buffer.from('hello')
        const signature = pair.Sign(data)
        const wire = SigningPublicKey.Parse(pair.PublicKey.ToJson())
        assert.equal(wire.Raw.length, 43)
        assert.ok(wire.Verify(data, signature))
        assert.ok(!wire.Verify(Buffer.from('hellO'), signature))
        assert.ok(!SigningKeyPair.Generate().PublicKey.Verify(data, signature))
        assert.match(pair.KeyId, KeyEncoding.KeyIdPattern)
        assert.equal(wire.KeyId, pair.KeyId)
    })

    it('round-trips the private half as PKCS#8 and the public half as SPKI, refusing other key types', () =>
    {
        const pair = SigningKeyPair.Generate()
        const again = SigningKeyPair.FromPrivatePem(pair.PrivatePem())
        assert.ok(again.PublicKey.Equals(pair.PublicKey))
        assert.ok(SigningPublicKey.FromPem(pair.PublicKey.ToPem()).Equals(pair.PublicKey))
        const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 })
        assert.throws(() => SigningPublicKey.FromKeyObject(rsa.publicKey), SigningKeyError)
        assert.throws(() => SigningKeyPair.FromPrivatePem('not a pem'), SigningKeyError)
        assert.throws(() => SigningPublicKey.Parse(SealingKeyPair.Generate().PublicKey.Raw.slice(1)), ProtocolDecodeError)
        assert.throws(() => SigningPublicKey.Parse(42), ProtocolDecodeError)
    })

    it('never prints its private half', () =>
    {
        const pair = SigningKeyPair.Generate()
        const pem = pair.PrivatePem()
        for (const text of [String(pair), JSON.stringify({ pair }), inspect(pair)])
        {
            assert.ok(!text.includes(pem.split('\n')[1] as string))
            assert.ok(text.includes('[signing key pair]'))
        }
    })

    it('gives the same raw key a different id as a sealing key', () =>
    {
        const raw = SigningKeyPair.Generate().PublicKey.Raw
        assert.notEqual(KeyEncoding.KeyId(raw, CurveKeyType.Ed25519), KeyEncoding.KeyId(raw, CurveKeyType.X25519))
    })
})

describe('SealedBlob', () =>
{
    const context = Buffer.from('{"PlacementId":"p1"}')

    it('opens only for the recipient under the same context', () =>
    {
        const platform = SealingKeyPair.Generate()
        const blob = SealedBlob.Seal(Buffer.from('kubeconfig bytes'), SealingPublicKey.Parse(platform.PublicKey.ToJson()), context)
        const wire = SealedBlob.Parse(JSON.parse(JSON.stringify(blob.ToJson())))
        assert.equal(wire.Open(platform, context).toString(), 'kubeconfig bytes')
        assert.ok(!JSON.stringify(blob.ToJson()).includes('kubeconfig'))
        assert.throws(() => wire.Open(SealingKeyPair.Generate(), context), SealedBlobError)
        assert.throws(() => wire.Open(platform, Buffer.from('{"PlacementId":"p2"}')), SealedBlobError)
    })

    it('does not open when any byte was altered', () =>
    {
        const platform = SealingKeyPair.Generate()
        const json = SealedBlob.Seal(Buffer.from('secret'), platform.PublicKey, context).ToJson()
        const flipped = (json.Ciphertext[0] === 'A' ? 'B' : 'A') + json.Ciphertext.slice(1)
        assert.throws(() => SealedBlob.Parse({ ...json, Ciphertext: flipped }).Open(platform, context), SealedBlobError)
        const tag = (json.Tag[0] === 'A' ? 'B' : 'A') + json.Tag.slice(1)
        assert.throws(() => SealedBlob.Parse({ ...json, Tag: tag }).Open(platform, context), SealedBlobError)
    })

    it('decodes strictly and refuses empty or oversized plaintext', () =>
    {
        const platform = SealingKeyPair.Generate()
        const json = SealedBlob.Seal(Buffer.from('x'), platform.PublicKey, context).ToJson()
        assert.throws(() => SealedBlob.Parse({ ...json, Extra: 1 }), ProtocolDecodeError)
        assert.throws(() => SealedBlob.Parse({ ...json, Algorithm: 'rsa' }), ProtocolDecodeError)
        assert.throws(() => SealedBlob.Parse({ ...json, Nonce: 'short' }), ProtocolDecodeError)
        assert.throws(() => SealedBlob.Seal(Buffer.alloc(0), platform.PublicKey, context), SealedBlobError)
        assert.throws(() => SealedBlob.Seal(Buffer.alloc(SealedBlob.MaxPlaintextBytes + 1), platform.PublicKey, context), SealedBlobError)
        assert.equal(SealedBlob.Seal(Buffer.alloc(SealedBlob.MaxPlaintextBytes, 7), platform.PublicKey, context).Open(platform, context).length, SealedBlob.MaxPlaintextBytes)
    })

    it('round-trips the sealing key pair through PKCS#8', () =>
    {
        const pair = SealingKeyPair.Generate()
        assert.ok(SealingKeyPair.FromPrivatePem(pair.PrivatePem()).PublicKey.Equals(pair.PublicKey))
        assert.ok(inspect(pair).includes('[sealing key pair]'))
    })
})
