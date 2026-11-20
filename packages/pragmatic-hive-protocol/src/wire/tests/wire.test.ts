import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CanonicalJson } from '../canonical-json.js'
import { DecodeReason, ProtocolDecodeError } from '../protocol-decode-error.js'
import { ProtocolJson } from '../protocol-json.js'
import { ProtocolNames } from '../protocol-names.js'
import { StrictFields } from '../strict-fields.js'

class Refusal
{
    public static Of(action: () => unknown, path: string, reason: DecodeReason): void
    {
        assert.throws(action, (error: unknown) => error instanceof ProtocolDecodeError && error.Path === path && error.Reason === reason)
    }
}

describe('StrictFields', () =>
{
    it('reads a closed shape: every listed member present, none other', () =>
    {
        const fields = StrictFields.Exactly({ A: 'x', B: null }, ['A', 'B'])
        assert.equal(fields.String('A', {}), 'x')
        assert.equal(fields.NullableString('B', {}), null)
        Refusal.Of(() => StrictFields.Exactly({ A: 'x' }, ['A', 'B']), 'message.B', DecodeReason.Missing)
        Refusal.Of(() => StrictFields.Exactly({ A: 'x', B: null, C: 1 }, ['A', 'B']), 'message.C', DecodeReason.Unknown)
        Refusal.Of(() => StrictFields.Exactly([], ['A']), 'message', DecodeReason.NotObject)
        Refusal.Of(() => StrictFields.Exactly(null, ['A']), 'message', DecodeReason.NotObject)
    })

    it('refuses wrong types, lengths, formats and ranges without echoing the value', () =>
    {
        const fields = StrictFields.Of({ S: 'secret-value', N: 1.5, B: 'yes', E: 'other', T: '2026-11-20T10:00:00Z', L: [1, 2, 3] })
        Refusal.Of(() => fields.String('S', { Max: 3 }), 'message.S', DecodeReason.BadLength)
        Refusal.Of(() => fields.String('S', { Pattern: /^[0-9]+$/ }), 'message.S', DecodeReason.BadFormat)
        Refusal.Of(() => fields.String('N', {}), 'message.N', DecodeReason.NotString)
        Refusal.Of(() => fields.Integer('N'), 'message.N', DecodeReason.NotInteger)
        Refusal.Of(() => fields.Boolean('B'), 'message.B', DecodeReason.NotBoolean)
        Refusal.Of(() => fields.Enum('E', ['a', 'b']), 'message.E', DecodeReason.NotAllowed)
        Refusal.Of(() => fields.Timestamp('T'), 'message.T', DecodeReason.NotTimestamp)
        Refusal.Of(() => fields.Array('L', 2, entry => entry), 'message.L', DecodeReason.TooMany)
        try
        {
            fields.String('S', { Max: 3 })
        }
        catch (error)
        {
            assert.ok(!(error as Error).message.includes('secret-value'))
        }
    })

    it('accepts only the one spelling of a timestamp Date.toISOString writes', () =>
    {
        assert.equal(StrictFields.Of({ T: '2026-11-20T10:00:00.000Z' }).Timestamp('T').toISOString(), '2026-11-20T10:00:00.000Z')
        Refusal.Of(() => StrictFields.Of({ T: '2026-02-30T10:00:00.000Z' }).Timestamp('T'), 'message.T', DecodeReason.NotTimestamp)
    })

    it('refuses duplicate entries in a unique array and names nested paths', () =>
    {
        Refusal.Of(() => StrictFields.Of({ L: ['a', 'a'] }).UniqueArray('L', 5, (entry, path) => StrictFields.StringAt(entry, path, {}), entry => entry), 'message.L', DecodeReason.Duplicate)
        Refusal.Of(() => StrictFields.Of({ L: ['a', 7] }).Array('L', 5, (entry, path) => StrictFields.StringAt(entry, path, {})), 'message.L[1]', DecodeReason.NotString)
    })
})

describe('CanonicalJson', () =>
{
    it('sorts keys at every depth and keeps array order', () =>
    {
        assert.equal(CanonicalJson.Stringify({ b: [2, 1], a: { d: true, c: null } }), '{"a":{"c":null,"d":true},"b":[2,1]}')
        assert.equal(CanonicalJson.Digest({ a: 1 }), CanonicalJson.Digest({ a: 1 }))
        assert.match(CanonicalJson.Digest({ a: 1 }), ProtocolNames.Digest)
    })

    it('refuses what has no single spelling: fractions, non-finite numbers, undefined, class instances', () =>
    {
        for (const value of [1.5, Number.NaN, Infinity, undefined, new Date(), { a: undefined }])
        {
            assert.throws(() => CanonicalJson.Stringify(value), ProtocolDecodeError)
        }
    })
})

describe('ProtocolJson', () =>
{
    it('refuses text over the byte limit before parsing, and text that is not JSON', () =>
    {
        Refusal.Of(() => ProtocolJson.Parse('"' + 'x'.repeat(100) + '"', 50), 'message', DecodeReason.TooLarge)
        Refusal.Of(() => ProtocolJson.Parse('{nope', 50), 'message', DecodeReason.NotJson)
        assert.deepEqual(ProtocolJson.Parse('{"a":1}', 50), { a: 1 })
    })
})

describe('ProtocolNames', () =>
{
    it('admits names and refuses free text', () =>
    {
        assert.ok(ProtocolNames.Label.test('hive-1'))
        assert.ok(!ProtocolNames.Label.test('Hive 1'))
        assert.ok(ProtocolNames.Component.test('tenant-admin'))
        assert.ok(!ProtocolNames.Component.test('a'.repeat(47)))
        assert.ok(ProtocolNames.Version.test('1.2.3-early.4'))
        assert.ok(!ProtocolNames.Version.test('error: connection refused'))
        assert.ok(ProtocolNames.HostName.test('acme.hives.pragmatic-tech.ai'))
        assert.ok(!ProtocolNames.HostName.test('localhost'))
        assert.ok(ProtocolNames.IsAddress('10.0.0.1') && ProtocolNames.IsAddress('fd00::1') && !ProtocolNames.IsAddress('300.0.0.1'))
    })
})
