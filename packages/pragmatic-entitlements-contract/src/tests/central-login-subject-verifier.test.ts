import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RealmTokenPrincipal, TokenVerifierUnavailableError } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import type { IRealmTokenVerifier } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { CentralLoginSubjectVerifier } from '../central-login/central-login-subject-verifier.js'

class Tokens implements IRealmTokenVerifier
{
    public static readonly Issuer = 'https://login.pragmatic-tech.ai/realms/central'

    public constructor(private readonly answers: ReadonlyMap<string, RealmTokenPrincipal>)
    {
    }

    public async Verify(token: string): Promise<RealmTokenPrincipal | undefined>
    {
        if (token === 'down')
        {
            throw new TokenVerifierUnavailableError('keys unreachable')
        }
        return this.answers.get(token)
    }

    public static Principal(payload: Record<string, unknown>, subject = 'u1'): RealmTokenPrincipal
    {
        return new RealmTokenPrincipal(Tokens.Issuer, subject, { sub: subject, ...payload })
    }
}

describe('CentralLoginSubjectVerifier', () =>
{
    const verifier = new CentralLoginSubjectVerifier(new Tokens(new Map([
        ['good', Tokens.Principal({ email: 'u1@acme.com' })],
        ['no-email', Tokens.Principal({})],
        ['bad-email', Tokens.Principal({ email: 'not an email' })],
        ['long-subject', Tokens.Principal({ email: 'u1@acme.com' }, 's'.repeat(300))],
    ])))

    it('names the customer of a verified central-login token: issuer, subject, email', async () =>
    {
        const subject = await verifier.Verify('good')
        assert.deepEqual(subject?.ToJson(), { Issuer: Tokens.Issuer, Subject: 'u1', Email: 'u1@acme.com' })
    })

    it('answers undefined for a token that is not valid, has no email or names no well-formed subject', async () =>
    {
        assert.equal(await verifier.Verify('unknown'), undefined)
        assert.equal(await verifier.Verify('no-email'), undefined)
        assert.equal(await verifier.Verify('bad-email'), undefined)
        assert.equal(await verifier.Verify('long-subject'), undefined)
    })

    it('throws when the token verifier cannot decide', async () =>
    {
        await assert.rejects(verifier.Verify('down'), TokenVerifierUnavailableError)
    })
})
