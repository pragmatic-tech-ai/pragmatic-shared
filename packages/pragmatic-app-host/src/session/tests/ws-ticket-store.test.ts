import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { WsTicketStore } from '../ws-ticket-store.js'
import { InMemoryTicketRepository } from '../ticket-repository.js'
import type { ITicketRepository } from '../ticket-repository.js'
import { SqlTicketRepository } from '../sql-ticket-repository.js'

class Clock
{
    public At = 1_000_000
    public readonly Now = (): number => this.At
}

class TicketCases
{
    public static Register(label: string, open: (clock: Clock) => Promise<ITicketRepository>): void
    {
        test(`${label}: Mint then Redeem returns the bound session id exactly once`, async () =>
        {
            const clock = new Clock()
            const store = new WsTicketStore(await open(clock), { Now: clock.Now })
            const ticket = await store.Mint('session-id-1')
            assert.equal(await store.Redeem(ticket), 'session-id-1')
            assert.equal(await store.Redeem(ticket), null)
        })

        test(`${label}: an expired ticket redeems to null`, async () =>
        {
            const clock = new Clock()
            const store = new WsTicketStore(await open(clock), { TtlMs: 30_000, Now: clock.Now })
            const ticket = await store.Mint('s')
            clock.At += 30_000
            assert.equal(await store.Redeem(ticket), null)
        })

        test(`${label}: an unknown ticket redeems to null`, async () =>
        {
            const clock = new Clock()
            const store = new WsTicketStore(await open(clock), { Now: clock.Now })
            assert.equal(await store.Redeem('nope'), null)
        })

        test(`${label}: tickets are opaque and distinct`, async () =>
        {
            const clock = new Clock()
            const store = new WsTicketStore(await open(clock), { Now: clock.Now })
            const a = await store.Mint('s')
            const b = await store.Mint('s')
            assert.notEqual(a, b)
            assert.match(a, /^[A-Za-z0-9_-]{32,}$/)
        })
    }
}

TicketCases.Register('InMemoryTicketRepository', clock => Promise.resolve(new InMemoryTicketRepository(undefined, clock.Now)))

test('InMemoryTicketRepository is bounded: the oldest ticket is evicted past maxTickets', async () =>
{
    const clock = new Clock()
    const store = new WsTicketStore(new InMemoryTicketRepository(2, clock.Now), { Now: clock.Now })
    const first = await store.Mint('a')
    const second = await store.Mint('b')
    const third = await store.Mint('c')
    assert.equal(await store.Redeem(first), null)
    assert.equal(await store.Redeem(second), 'b')
    assert.equal(await store.Redeem(third), 'c')
})

SqlTestSessions.Describe('SqlTicketRepository', (makeSession, backend) =>
{
    TicketCases.Register(backend, async clock => await SqlTicketRepository.Open(await makeSession(), clock.Now))

    test(`${backend}: the repository stores a digest of the ticket, never the ticket`, async () =>
    {
        const clock = new Clock()
        const session = await makeSession()
        const store = new WsTicketStore(await SqlTicketRepository.Open(session, clock.Now), { Now: clock.Now })
        const ticket = await store.Mint('s')
        const rows = await session.Query('SELECT ticket_hash FROM app_host_ws_tickets', [])
        assert.equal(rows.length, 1)
        assert.notEqual(rows[0]!.ticket_hash, ticket)
    })

    test(`${backend}: a ticket minted on one replica redeems on another`, async () =>
    {
        const clock = new Clock()
        const session = await makeSession()
        const ticket = await new WsTicketStore(await SqlTicketRepository.Open(session, clock.Now), { Now: clock.Now }).Mint('s')
        assert.equal(await new WsTicketStore(await SqlTicketRepository.Open(session, clock.Now), { Now: clock.Now }).Redeem(ticket), 's')
    })
})

SqlTestSessions.DescribeLive('SqlTicketRepository', makeDatabase =>
{
    test('SqlTicketRepository [live]: concurrent redeems of one ticket - exactly one wins', async () =>
    {
        const database = await makeDatabase()
        const clock = new Clock()
        const ticket = await new WsTicketStore(await SqlTicketRepository.Open(database.Session(), clock.Now), { Now: clock.Now }).Mint('s')
        const racers = await Promise.all(Array.from({ length: 8 }, async () => new WsTicketStore(await SqlTicketRepository.Open(database.Session(), clock.Now), { Now: clock.Now }).Redeem(ticket)))
        assert.equal(racers.filter(r => r !== null).length, 1)
        await database.Dispose()
    })
})
