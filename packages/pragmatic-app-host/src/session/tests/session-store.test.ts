import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionStore } from '../session-store.js'
import { InMemorySessionRepository } from '../session-repository.js'
import type { ISessionRepository } from '../session-repository.js'
import type { SessionRecord } from '../session-record.js'
import { SessionClaims } from '../session-claims.js'
import { SessionPolicy } from '../session-policy.js'

class Clock
{
    public At = new Date('2026-11-20T10:00:00.000Z').getTime()
    public readonly Now = (): Date => new Date(this.At)
}

/** An in-memory repository whose writes can be made to fail. */
class FlakyRepository implements ISessionRepository
{
    public readonly Inner = new InMemorySessionRepository()
    public FailWrites = false

    public Insert(record: SessionRecord): Promise<void>
    {
        return this.Write(() => this.Inner.Insert(record))
    }

    public Find(id: string): Promise<SessionRecord | null>
    {
        return this.Inner.Find(id)
    }

    public Delete(id: string): Promise<boolean>
    {
        return this.Write(() => this.Inner.Delete(id))
    }

    public DeleteSubject(subject: string): Promise<number>
    {
        return this.Write(() => this.Inner.DeleteSubject(subject))
    }

    public ReplaceSubject(subject: string, fresh: SessionRecord): Promise<number>
    {
        return this.Write(() => this.Inner.ReplaceSubject(subject, fresh))
    }

    public Extend(id: string, expiresAt: Date, keptAt: Date): Promise<boolean>
    {
        return this.Write(() => this.Inner.Extend(id, expiresAt, keptAt))
    }

    public DeleteExpired(now: Date): Promise<number>
    {
        return this.Write(() => this.Inner.DeleteExpired(now))
    }

    private async Write<T>(work: () => Promise<T>): Promise<T>
    {
        if (this.FailWrites)
        {
            throw new Error('disk full')
        }
        return await work()
    }
}

class Fixture
{
    public static readonly TtlMs = 60_000
    public static readonly Claims = SessionClaims.From({ email: 'a@x', roles: ['app.admin'] })

    public static Store(clock: Clock, repository: ISessionRepository = new InMemorySessionRepository()): SessionStore
    {
        return new SessionStore(repository, new SessionPolicy(Fixture.TtlMs), clock.Now)
    }
}

test('Issue hands back an opaque token once; Validate returns the subject and claims; the repository keeps only its digest', async () =>
{
    const clock = new Clock()
    const repository = new InMemorySessionRepository()
    const store = Fixture.Store(clock, repository)
    const issued = await store.Issue('alice', Fixture.Claims)
    assert.match(issued.Token, /^[A-Za-z0-9_-]{43}$/)
    const session = await store.Validate(issued.Token)
    assert.equal(session?.Subject, 'alice')
    assert.deepEqual(session?.Claims, Fixture.Claims)
    assert.equal(session?.Id, SessionStore.DigestOf(issued.Token))
    assert.equal(await repository.Find(issued.Token), null)
    assert.notEqual(await repository.Find(SessionStore.DigestOf(issued.Token)), null)
})

test('an unknown token, and a garbage one, validate as null', async () =>
{
    const store = Fixture.Store(new Clock())
    assert.equal(await store.Validate('nope'), null)
    assert.equal(await store.Validate(''), null)
})

test('a session whose expiry equals now is refused and deleted', async () =>
{
    const clock = new Clock()
    const repository = new InMemorySessionRepository()
    const store = Fixture.Store(clock, repository)
    const issued = await store.Issue('alice', Fixture.Claims)
    clock.At += Fixture.TtlMs
    assert.equal(await store.Validate(issued.Token), null)
    assert.equal(await repository.Find(issued.Session.Id), null)
})

test('Revoke ends the session', async () =>
{
    const store = Fixture.Store(new Clock())
    const issued = await store.Issue('alice', Fixture.Claims)
    await store.Revoke(issued.Token)
    assert.equal(await store.Validate(issued.Token), null)
})

test('RevokeSubject ends every session of the subject, and only those', async () =>
{
    const store = Fixture.Store(new Clock())
    const a1 = await store.Issue('alice', Fixture.Claims)
    const a2 = await store.Issue('alice', Fixture.Claims)
    const b1 = await store.Issue('bob', Fixture.Claims)
    assert.equal(await store.RevokeSubject('alice'), 2)
    assert.equal(await store.Validate(a1.Token), null)
    assert.equal(await store.Validate(a2.Token), null)
    assert.notEqual(await store.Validate(b1.Token), null)
})

test('Rotate ends every session of the subject (the caller\'s too) and issues one fresh session with the caller\'s claims', async () =>
{
    const store = Fixture.Store(new Clock())
    const caller = await store.Issue('alice', Fixture.Claims)
    const other = await store.Issue('alice', Fixture.Claims)
    const fresh = await store.Rotate(caller.Token)
    assert.ok(fresh !== null)
    assert.notEqual(fresh.Token, caller.Token)
    assert.equal(await store.Validate(caller.Token), null)
    assert.equal(await store.Validate(other.Token), null)
    assert.deepEqual((await store.Validate(fresh.Token))?.Claims, Fixture.Claims)
    assert.equal(await store.Rotate('unknown'), null)
})

test('a revocation whose write fails still takes effect at once (fail closed); the error is rethrown', async () =>
{
    const clock = new Clock()
    const repository = new FlakyRepository()
    const store = Fixture.Store(clock, repository)
    const issued = await store.Issue('alice', Fixture.Claims)
    repository.FailWrites = true
    await assert.rejects(store.Revoke(issued.Token), /disk full/)
    assert.equal(await store.Validate(issued.Token), null)
    repository.FailWrites = false
    assert.equal(await store.Validate(issued.Token), null)
})

test('a subject revocation whose write fails refuses every session issued until then, and not a later one', async () =>
{
    const clock = new Clock()
    const repository = new FlakyRepository()
    const store = Fixture.Store(clock, repository)
    const before = await store.Issue('alice', Fixture.Claims)
    const bob = await store.Issue('bob', Fixture.Claims)
    repository.FailWrites = true
    await assert.rejects(store.RevokeSubject('alice'))
    assert.equal(await store.Validate(before.Token), null)
    assert.notEqual(await store.Validate(bob.Token), null)
    repository.FailWrites = false
    clock.At += 1
    const after = await store.Issue('alice', Fixture.Claims)
    assert.notEqual(await store.Validate(after.Token), null)
})

test('a grant whose write fails is not valid: Issue and Rotate are strict', async () =>
{
    const repository = new FlakyRepository()
    const store = Fixture.Store(new Clock(), repository)
    const issued = await store.Issue('alice', Fixture.Claims)
    repository.FailWrites = true
    await assert.rejects(store.Issue('alice', Fixture.Claims))
    await assert.rejects(store.Rotate(issued.Token))
    repository.FailWrites = false
    assert.notEqual(await store.Validate(issued.Token), null)
})

test('a sliding policy renews on use at most once per interval, never past the maximum lifetime', async () =>
{
    const clock = new Clock()
    const hour = 3_600_000
    const day = 24 * hour
    const store = new SessionStore(new InMemorySessionRepository(), new SessionPolicy(7 * day, hour, 30 * day), clock.Now)
    const issued = await store.Issue('alice', Fixture.Claims)
    const issuedAt = clock.At
    clock.At += hour - 1
    assert.equal((await store.Validate(issued.Token))?.ExpiresAt.getTime(), issuedAt + 7 * day)
    clock.At += 1
    assert.equal((await store.Validate(issued.Token))?.ExpiresAt.getTime(), clock.At + 7 * day)
    for (let i = 0; i < 4; i++)
    {
        clock.At += 6 * day
        assert.notEqual(await store.Validate(issued.Token), null)
    }
    assert.equal((await store.Validate(issued.Token))?.ExpiresAt.getTime(), issuedAt + 30 * day)
    clock.At = issuedAt + 30 * day
    assert.equal(await store.Validate(issued.Token), null)
})

test('a fixed policy does not slide', async () =>
{
    const clock = new Clock()
    const store = Fixture.Store(clock)
    const issued = await store.Issue('alice', Fixture.Claims)
    clock.At += Fixture.TtlMs - 1
    assert.equal((await store.Validate(issued.Token))?.ExpiresAt.getTime(), clock.At + 1)
})

test('Issue can take its own policy: two kinds of session over one repository', async () =>
{
    const clock = new Clock()
    const store = Fixture.Store(clock)
    const long = await store.Issue('alice', Fixture.Claims, new SessionPolicy(10 * Fixture.TtlMs))
    clock.At += 2 * Fixture.TtlMs
    assert.notEqual(await store.Validate(long.Token), null)
})

test('a failed renewal write returns the un-slid session while it is live', async () =>
{
    const clock = new Clock()
    const repository = new FlakyRepository()
    const store = new SessionStore(repository, new SessionPolicy(10_000, 1000, 100_000), clock.Now)
    const issued = await store.Issue('alice', Fixture.Claims)
    clock.At += 1000
    repository.FailWrites = true
    const session = await store.Validate(issued.Token)
    assert.equal(session?.ExpiresAt.getTime(), issued.Session.ExpiresAt.getTime())
})

test('ValidateId validates by the session id (the digest), never by a token', async () =>
{
    const clock = new Clock()
    const store = Fixture.Store(clock)
    const issued = await store.Issue('alice', Fixture.Claims)
    assert.equal((await store.ValidateId(issued.Session.Id))?.Subject, 'alice')
    await store.Revoke(issued.Token)
    assert.equal(await store.ValidateId(issued.Session.Id), null)
})

test('Issue sweeps expired sessions', async () =>
{
    const clock = new Clock()
    const repository = new InMemorySessionRepository()
    const store = Fixture.Store(clock, repository)
    const old = await store.Issue('alice', Fixture.Claims)
    clock.At += Fixture.TtlMs
    await store.Issue('bob', Fixture.Claims)
    assert.equal(await repository.Find(old.Session.Id), null)
})
