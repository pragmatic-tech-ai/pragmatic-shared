import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { RequestContext } from '../request-context.js'
import { HttpProblem } from '../../http/http-problem.js'

class Fixture
{
    public static Context(params: Record<string, string> = {}): RequestContext
    {
        return new RequestContext({} as IncomingMessage, {} as ServerResponse, '/api/x', new Map(Object.entries(params)), new URLSearchParams('a=1'), null, '10.0.0.1', 1024)
    }
}

test('Param reads a declared parameter; an undeclared one is a programming error', () =>
{
    const context = Fixture.Context({ id: 'h1' })
    assert.equal(context.Param('id'), 'h1')
    assert.throws(() => context.Param('other'))
})

test('RequireSession is a 401 problem on a public route without a session', () =>
{
    assert.throws(() => Fixture.Context().RequireSession(), (err: unknown) => err instanceof HttpProblem && err.Status === 401)
})

test('NoteAudit sets the note the audit entry carries; the query and address are exposed', () =>
{
    const context = Fixture.Context()
    assert.equal(context.AuditNote, undefined)
    context.NoteAudit('kept 2 volumes')
    assert.equal(context.AuditNote, 'kept 2 volumes')
    assert.equal(context.Query.get('a'), '1')
    assert.equal(context.ClientAddress, '10.0.0.1')
})
