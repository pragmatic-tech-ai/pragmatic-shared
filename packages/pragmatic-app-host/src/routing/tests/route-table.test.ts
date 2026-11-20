import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RouteTable } from '../route-table.js'
import { RouteAuth } from '../route.js'
import type { RouteDefinition } from '../route.js'
import { RoutePattern } from '../route-pattern.js'
import { HttpMethod } from '../../http/http-method.js'

class Fixture
{
    public static Route(method: HttpMethod, pattern: string, auth: RouteAuth = RouteAuth.Session): RouteDefinition
    {
        return { Method: method, Pattern: pattern, Auth: auth, Handler: async () => undefined }
    }
}

test('RoutePattern matches literal segments and :params, decoding each param once', () =>
{
    const pattern = new RoutePattern('/api/hives/:id/agents/:agent')
    assert.deepEqual(Object.fromEntries(pattern.Match('/api/hives/h%201/agents/a2') ?? []), { id: 'h 1', agent: 'a2' })
    assert.equal(pattern.Match('/api/hives/h1/agents'), null)
    assert.equal(pattern.Match('/api/hives/h1/agents/a2/x'), null)
    assert.equal(pattern.Match('/api/hives//agents/a2'), null)
    assert.equal(pattern.Match('/api/hives/%E0/agents/a2'), null)
})

test('a trailing * matches the rest of the path (at least one segment)', () =>
{
    const pattern = new RoutePattern('/files/*')
    assert.deepEqual(Object.fromEntries(pattern.Match('/files/a/b.txt') ?? []), { '*': 'a/b.txt' })
    assert.equal(pattern.Match('/files'), null)
})

test('a pattern must start with / and * may only end it', () =>
{
    assert.throws(() => new RoutePattern('api/x'))
    assert.throws(() => new RoutePattern('/a/*/b'))
})

test('Match finds the route for the method and path, with its params', () =>
{
    const table = new RouteTable()
        .Add(Fixture.Route(HttpMethod.Get, '/api/hives'))
        .Add(Fixture.Route(HttpMethod.Get, '/api/hives/:id'))
        .Add(Fixture.Route(HttpMethod.Delete, '/api/hives/:id'))
    const found = table.Match('DELETE', '/api/hives/h1')
    assert.equal(found.Route?.Method, HttpMethod.Delete)
    assert.equal(found.Params.get('id'), 'h1')
})

test('a path that matches only under other methods lists them; an unknown path lists none', () =>
{
    const table = new RouteTable()
        .Add(Fixture.Route(HttpMethod.Get, '/api/hives/:id'))
        .Add(Fixture.Route(HttpMethod.Delete, '/api/hives/:id'))
    const wrongMethod = table.Match('POST', '/api/hives/h1')
    assert.equal(wrongMethod.Route, undefined)
    assert.deepEqual(wrongMethod.AllowedMethods, [HttpMethod.Get, HttpMethod.Delete])
    const unknown = table.Match('GET', '/api/nothing')
    assert.equal(unknown.Route, undefined)
    assert.deepEqual(unknown.AllowedMethods, [])
})

test('a literal route wins over a param route declared earlier', () =>
{
    const table = new RouteTable()
        .Add(Fixture.Route(HttpMethod.Get, '/api/hives/:id'))
        .Add(Fixture.Route(HttpMethod.Get, '/api/hives/summary', RouteAuth.Public))
    assert.equal(table.Match('GET', '/api/hives/summary').Route?.Auth, RouteAuth.Public)
    assert.equal(table.Match('GET', '/api/hives/h1').Route?.Auth, RouteAuth.Session)
})

test('declaring one method and pattern twice is refused', () =>
{
    const table = new RouteTable().Add(Fixture.Route(HttpMethod.Get, '/api/x'))
    assert.throws(() => table.Add(Fixture.Route(HttpMethod.Get, '/api/x')))
})

test('a body limit must be a positive integer', () =>
{
    assert.throws(() => new RouteTable().Add({ ...Fixture.Route(HttpMethod.Post, '/api/x'), BodyLimit: 0 }))
})

test('socket routes are declared and matched separately', () =>
{
    const table = new RouteTable().AddSocket({ Pattern: '/api/events', Auth: RouteAuth.Session, Handler: () => undefined })
    assert.notEqual(table.MatchSocket('/api/events'), undefined)
    assert.equal(table.MatchSocket('/api/other'), undefined)
    assert.equal(table.Match('GET', '/api/events').Route, undefined)
})
