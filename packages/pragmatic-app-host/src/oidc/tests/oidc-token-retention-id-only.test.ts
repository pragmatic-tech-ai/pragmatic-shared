import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { OidcTokenSet } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { SessionTokenRetention } from '../tokens/session-token-retention.js'
import { SessionTokenVault } from '../tokens/session-token-vault.js'
import { InMemorySessionTokenRepository } from '../tokens/session-token-repository.js'
import { IssuedSession, SessionRecord } from '../../session/session-record.js'
import { SessionPolicy } from '../../session/session-policy.js'
import { SessionClaims } from '../../session/session-claims.js'

class IdOnlyFixture
{
    public static readonly Bearer = 'bearer-1'

    public static Tokens(): OidcTokenSet
    {
        return new OidcTokenSet('sub-1', 'id-token', new Date(Date.now() + 300_000), 'access-token', new Date(Date.now() + 300_000), 'refresh-token')
    }

    public static Issued(): IssuedSession
    {
        const now = new Date()
        return new IssuedSession(IdOnlyFixture.Bearer, new SessionRecord('sid-1', 'sub-1', SessionClaims.Empty, now, new Date(now.getTime() + 60_000), now, new SessionPolicy(60_000)))
    }
}

describe('SessionTokenRetention IdTokenOnly', () =>
{
    it('keeps the ID token alone: no access or refresh token is ever sealed', async () =>
    {
        const vault = new SessionTokenVault(randomBytes(32))
        const repository = new InMemorySessionTokenRepository()
        const retention = new SessionTokenRetention({ Vault: vault, Repository: repository, RelyingParty: {} as never, Clients: {} as never, IdTokenOnly: true })
        await retention.Keep(IdOnlyFixture.Issued(), IdOnlyFixture.Tokens())
        const row = await repository.Find('sid-1')
        const kept = vault.Open(IdOnlyFixture.Bearer, row!.Sealed)
        assert.deepEqual([kept?.IdToken, kept?.AccessToken, kept?.RefreshToken], ['id-token', null, null])
    })

    it('IdTokenOf drops the access and refresh tokens and keeps the subject and expiry', () =>
    {
        const tokens = IdOnlyFixture.Tokens()
        const kept = SessionTokenRetention.IdTokenOf(tokens)
        assert.deepEqual([kept.Subject, kept.IdToken, kept.IdTokenExpiresAt, kept.AccessToken, kept.RefreshToken, kept.Refreshable], [tokens.Subject, tokens.IdToken, tokens.IdTokenExpiresAt, null, null, false])
    })
})
