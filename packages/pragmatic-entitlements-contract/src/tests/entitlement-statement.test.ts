import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BadRequestProblem } from '@pragmatic-tech-ai/pragmatic-app-host'
import { EntitlementStatement } from '../statement/entitlement-statement.js'
import { ClientKind } from '../client/client-kind.js'
import { EntitlementState } from '../entitlement/entitlement.js'
import { CentralLoginSubject } from '../central-login/central-login-subject.js'
import { Samples } from './support/samples.js'

class Refused
{
    public static Of(json: Record<string, unknown>): void
    {
        assert.throws(() => EntitlementStatement.Parse(json), (err: unknown) => err instanceof BadRequestProblem && err.Code === 'invalid-request')
    }
}

describe('EntitlementStatement', () =>
{
    it('decodes a schema-1 statement and encodes it back unchanged', () =>
    {
        const json = Samples.Json()
        const statement = EntitlementStatement.Parse(json)
        assert.equal(statement.ClientId, 'acme')
        assert.equal(statement.ClientKind, ClientKind.Organisation)
        assert.equal(statement.State, EntitlementState.Active)
        assert.equal(statement.Version, 7)
        assert.equal(statement.Limits.Get('hives'), 3)
        assert.equal(statement.IssuedAt.toISOString(), '2026-11-20T10:00:00.000Z')
        assert.deepEqual(statement.ToJson(), json)
    })

    it('builds through the same rules', () =>
    {
        const statement = Samples.Statement(1)
        assert.deepEqual(EntitlementStatement.Parse(JSON.parse(JSON.stringify(statement.ToJson()))).ToJson(), statement.ToJson())
        assert.throws(() => Samples.Statement(0), BadRequestProblem)
    })

    it('carries a person client the same way as an organisation', () =>
    {
        assert.equal(EntitlementStatement.Parse(Samples.Json({ ClientKind: 'person' })).ClientKind, ClientKind.Person)
    })

    it('knows its customer admins by issuer and subject, not email', () =>
    {
        const statement = EntitlementStatement.Parse(Samples.Json())
        assert.equal(statement.IsAdmin(CentralLoginSubject.Of(Samples.Issuer, 'u1', 'changed@acme.com')), true)
        assert.equal(statement.IsAdmin(Samples.Other), false)
        assert.equal(statement.IsAdmin(CentralLoginSubject.Of('https://other.example', 'u1', 'a@acme.com')), false)
    })

    it('refuses another schema, unknown members and every malformed member', () =>
    {
        Refused.Of(Samples.Json({ Schema: 2 }))
        Refused.Of({ ...Samples.Json(), Price: 10 })
        Refused.Of(Samples.Json({ ClientId: 'Acme' }))
        Refused.Of(Samples.Json({ ClientId: '-acme' }))
        Refused.Of(Samples.Json({ ClientKind: 'robot' }))
        Refused.Of(Samples.Json({ ClientName: '' }))
        Refused.Of(Samples.Json({ Admins: [] }))
        Refused.Of(Samples.Json({ Admins: [Samples.Admin.ToJson(), Samples.Admin.ToJson()] }))
        Refused.Of(Samples.Json({ Admins: [{ ...Samples.Admin.ToJson(), Issuer: 'http://insecure.example' }] }))
        Refused.Of(Samples.Json({ Admins: [{ ...Samples.Admin.ToJson(), Email: 'nope' }] }))
        Refused.Of(Samples.Json({ Admins: [{ ...Samples.Admin.ToJson(), Extra: 1 }] }))
        Refused.Of(Samples.Json({ PlanId: '' }))
        Refused.Of(Samples.Json({ Limits: { tenants: -1 } }))
        Refused.Of(Samples.Json({ Limits: { tenants: 1.5 } }))
        Refused.Of(Samples.Json({ Limits: { Tenants: 1 } }))
        Refused.Of(Samples.Json({ State: 'cancelled' }))
        Refused.Of(Samples.Json({ Version: 0 }))
        Refused.Of(Samples.Json({ Version: '7' }))
        Refused.Of(Samples.Json({ IssuedAt: '2026-11-20' }))
        Refused.Of(Samples.Json({ IssuedAt: '2026-13-45T10:00:00Z' }))
    })

    it('allows a plan with no limits at all (it entitles nothing)', () =>
    {
        assert.deepEqual(EntitlementStatement.Parse(Samples.Json({ Limits: {} })).Limits.Names, [])
    })
})
