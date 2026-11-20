import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { JsonFields } from '../json-fields.js'
import { BadRequestProblem } from '../http-problem.js'

class Refusal
{
    /** Asserts a 400 `invalid-request` whose message is `path: ...` and does not echo `secret`. */
    public static Of(action: () => unknown, path: string, secret = 'SECRET-VALUE'): void
    {
        assert.throws(action, (err: unknown) => err instanceof BadRequestProblem && err.Code === 'invalid-request' && err.message.startsWith(path + ': ') && !err.message.includes(secret))
    }
}

describe('JsonFields', () =>
{
    it('refuses a body that is not an object', () =>
    {
        Refusal.Of(() => JsonFields.Of([]), 'body')
        Refusal.Of(() => JsonFields.Of(null), 'body')
        Refusal.Of(() => JsonFields.Of('x'), 'body')
    })

    it('reads strings with length and pattern rules, never echoing the value', () =>
    {
        const fields = JsonFields.Of({ Name: 'acme', Long: 'SECRET-VALUE', Empty: '', Number: 3 })
        assert.equal(fields.String('Name', { Pattern: /^[a-z]+$/ }), 'acme')
        Refusal.Of(() => fields.String('Long', { Max: 3 }), 'body.Long')
        Refusal.Of(() => fields.String('Long', { Pattern: /^[a-z]+$/ }), 'body.Long')
        Refusal.Of(() => fields.String('Empty'), 'body.Empty')
        Refusal.Of(() => fields.String('Number'), 'body.Number')
        Refusal.Of(() => fields.String('Missing'), 'body.Missing')
        assert.equal(fields.NullableString('Missing'), null)
        assert.equal(JsonFields.Of({ A: null }).NullableString('A'), null)
    })

    it('reads safe integers within a range', () =>
    {
        const fields = JsonFields.Of({ A: 3, B: 1.5, C: -1, D: '3', E: 2 ** 60 })
        assert.equal(fields.Integer('A', { Min: 0, Max: 3 }), 3)
        Refusal.Of(() => fields.Integer('B'), 'body.B')
        Refusal.Of(() => fields.Integer('C', { Min: 0 }), 'body.C')
        Refusal.Of(() => fields.Integer('D'), 'body.D')
        Refusal.Of(() => fields.Integer('E'), 'body.E')
    })

    it('reads booleans and enums', () =>
    {
        const fields = JsonFields.Of({ On: true, Kind: 'person', Bad: 'robot' })
        assert.equal(fields.Boolean('On'), true)
        Refusal.Of(() => fields.Boolean('Kind'), 'body.Kind')
        assert.equal(fields.Enum('Kind', ['organisation', 'person'] as const), 'person')
        Refusal.Of(() => fields.Enum('Bad', ['organisation', 'person'] as const), 'body.Bad')
        assert.equal(fields.OptionalEnum('Missing', ['a', 'b'] as const, 'b'), 'b')
    })

    it('reads nested objects and arrays with their paths', () =>
    {
        const fields = JsonFields.Of({ Admins: [{ Subject: 'u1' }, { Subject: 7 }], Inner: { X: 1 } })
        Refusal.Of(() => fields.Array('Admins', 5, (entry, path) => JsonFields.Of(entry, path).String('Subject')), 'body.Admins[1].Subject')
        Refusal.Of(() => fields.Array('Admins', 1, entry => entry), 'body.Admins')
        Refusal.Of(() => fields.Array('Inner', 5, entry => entry), 'body.Inner')
        assert.equal(fields.Object('Inner').Integer('X'), 1)
        assert.equal(fields.NullableObject('Missing'), null)
        assert.equal(fields.Read('Inner', (value, path) => JsonFields.Of(value, path).Integer('X')), 1)
        Refusal.Of(() => fields.Read('Inner', (value, path) => JsonFields.Of(value, path).Integer('Y')), 'body.Inner.Y')
        assert.equal(fields.NullableRead('Missing', value => value), null)
        assert.equal(JsonFields.StringAt('a', 'body.X[0]'), 'a')
        Refusal.Of(() => JsonFields.StringAt(1, 'body.X[0]'), 'body.X[0]')
    })

    it('reads an integer map with key and value rules', () =>
    {
        const fields = JsonFields.Of({ Limits: { tenants: 1, hives: 3 }, BadKey: { 'No Spaces': 1 }, BadValue: { tenants: -1 } })
        assert.deepEqual([...fields.IntegerMap('Limits', /^[a-z-]+$/, 8, { Min: 0 })], [['tenants', 1], ['hives', 3]])
        Refusal.Of(() => fields.IntegerMap('Limits', /^[a-z-]+$/, 1), 'body.Limits')
        Refusal.Of(() => fields.IntegerMap('BadKey', /^[a-z-]+$/, 8), 'body.BadKey.No Spaces')
        Refusal.Of(() => fields.IntegerMap('BadValue', /^[a-z-]+$/, 8, { Min: 0 }), 'body.BadValue.tenants')
    })

    it('reads UTC timestamps', () =>
    {
        const fields = JsonFields.Of({ A: '2026-11-20T10:00:00.000Z', B: '2026-11-20T10:00:00Z', C: '2026-11-20', D: '2026-13-45T10:00:00Z', E: 5 })
        assert.equal(fields.Timestamp('A').toISOString(), '2026-11-20T10:00:00.000Z')
        assert.equal(fields.Timestamp('B').toISOString(), '2026-11-20T10:00:00.000Z')
        Refusal.Of(() => fields.Timestamp('C'), 'body.C')
        Refusal.Of(() => fields.Timestamp('D'), 'body.D')
        Refusal.Of(() => fields.Timestamp('E'), 'body.E')
        assert.equal(fields.NullableTimestamp('Missing'), null)
    })

    it('refuses unknown members', () =>
    {
        const fields = JsonFields.Of({ Name: 'a', Extra: 1 })
        Refusal.Of(() => fields.OnlyKnown(['Name']), 'body.Extra')
        assert.equal(fields.OnlyKnown(['Name', 'Extra']), fields)
    })
})
