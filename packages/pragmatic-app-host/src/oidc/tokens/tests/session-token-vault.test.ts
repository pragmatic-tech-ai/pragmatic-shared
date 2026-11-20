import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { OidcTokenSet } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { SessionTokenVault } from '../session-token-vault.js'
import { InMemorySessionTokenRepository, SealedSessionTokens } from '../session-token-repository.js'
import type { ISessionTokenRepository } from '../session-token-repository.js'
import { SqlSessionTokenRepository } from '../sql-session-token-repository.js'
import { SessionStore } from '../../../session/session-store.js'

class Fixture
{
    public static readonly Key = randomBytes(32)
    public static readonly Bearer = 'bearer-token-AAAA'

    public static Tokens(): OidcTokenSet
    {
        return new OidcTokenSet('u1', 'id.token.value', new Date(2_000_000), 'access-value', new Date(1_500_000), 'refresh-value')
    }
}

describe('SessionTokenVault', () =>
{
    test('seals a token set under the key and the session bearer, and opens it back whole', () =>
    {
        const vault = new SessionTokenVault(Fixture.Key)
        const sealed = vault.Seal(Fixture.Bearer, Fixture.Tokens())
        for (const secret of ['id.token.value', 'access-value', 'refresh-value'])
        {
            assert.ok(!sealed.includes(secret))
        }
        assert.deepEqual(vault.Open(Fixture.Bearer, sealed), Fixture.Tokens())
    })

    test('a token set without access or refresh token round-trips', () =>
    {
        const vault = new SessionTokenVault(Fixture.Key)
        const tokens = new OidcTokenSet('u1', 'id', new Date(5_000), null, null, null)
        assert.deepEqual(vault.Open(Fixture.Bearer, vault.Seal(Fixture.Bearer, tokens)), tokens)
    })

    test('another bearer, another key or a tampered seal opens nothing', () =>
    {
        const vault = new SessionTokenVault(Fixture.Key)
        const sealed = vault.Seal(Fixture.Bearer, Fixture.Tokens())
        assert.equal(vault.Open('another-bearer', sealed), undefined)
        assert.equal(new SessionTokenVault(randomBytes(32)).Open(Fixture.Bearer, sealed), undefined)
        const bytes = Buffer.from(sealed, 'base64url')
        bytes[20] = (bytes[20] as number) ^ 1
        assert.equal(vault.Open(Fixture.Bearer, bytes.toString('base64url')), undefined)
        assert.equal(vault.Open(Fixture.Bearer, 'garbage'), undefined)
    })

    test('refuses a key shorter than 32 bytes', () =>
    {
        assert.throws(() => new SessionTokenVault(randomBytes(16)))
        assert.throws(() => SessionTokenVault.FromSecret('short'))
        assert.ok(SessionTokenVault.FromSecret('x'.repeat(32)) instanceof SessionTokenVault)
    })
})

class RepositoryCases
{
    public static Register(label: string, open: () => Promise<ISessionTokenRepository>): void
    {
        test(`${label}: Put then Find by session id; Put again replaces; Delete removes`, async () =>
        {
            const repository = await open()
            const id = SessionStore.DigestOf(Fixture.Bearer)
            await repository.Put(new SealedSessionTokens(id, 'sealed-1', new Date(10_000)))
            assert.deepEqual(await repository.Find(id), new SealedSessionTokens(id, 'sealed-1', new Date(10_000)))
            await repository.Put(new SealedSessionTokens(id, 'sealed-2', new Date(20_000)))
            assert.equal((await repository.Find(id))?.Sealed, 'sealed-2')
            await repository.Delete(id)
            assert.equal(await repository.Find(id), undefined)
        })

        test(`${label}: DeleteExpired drops the rows at or past their expiry`, async () =>
        {
            const repository = await open()
            await repository.Put(new SealedSessionTokens('a', 's', new Date(1_000)))
            await repository.Put(new SealedSessionTokens('b', 's', new Date(3_000)))
            assert.equal(await repository.DeleteExpired(new Date(1_000)), 1)
            assert.equal(await repository.Find('a'), undefined)
            assert.ok(await repository.Find('b') !== undefined)
        })
    }
}

RepositoryCases.Register('InMemorySessionTokenRepository', () => Promise.resolve(new InMemorySessionTokenRepository()))

SqlTestSessions.Describe('SqlSessionTokenRepository', (makeSession, backend) =>
{
    RepositoryCases.Register(backend, async () => await SqlSessionTokenRepository.Open(await makeSession()))

    test(`${backend}: the table holds the session id, the seal and the expiry only`, async () =>
    {
        const session = await makeSession()
        const repository = await SqlSessionTokenRepository.Open(session)
        const vault = new SessionTokenVault(Fixture.Key)
        await repository.Put(new SealedSessionTokens(SessionStore.DigestOf(Fixture.Bearer), vault.Seal(Fixture.Bearer, Fixture.Tokens()), new Date(10_000)))
        const rows = await session.Query('SELECT * FROM app_host_session_tokens', [])
        assert.deepEqual(Object.keys(rows[0] ?? {}).sort(), ['expires_at', 'sealed', 'session_id'])
        assert.ok(!JSON.stringify(rows).includes('id.token.value'))
    })
})
