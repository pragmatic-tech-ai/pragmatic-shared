import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { InternalApiCredential } from '@pragmatic-tech-ai/pragmatic-app-host'
import { CustomerCallAuthenticator, CustomerCallOutcome } from '../central-login/customer-call-authenticator.js'
import type { ICentralLoginVerifier } from '../central-login/central-login-verifier.js'
import type { CentralLoginSubject } from '../central-login/central-login-subject.js'
import { Samples } from './support/samples.js'

class TokenVerifier implements ICentralLoginVerifier
{
    public readonly Seen: string[] = []

    public async Verify(token: string): Promise<CentralLoginSubject | undefined>
    {
        this.Seen.push(token)
        return token === 'good-token' ? Samples.Admin : undefined
    }
}

describe('CustomerCallAuthenticator', () =>
{
    const credential = InternalApiCredential.FromSecret(Buffer.alloc(32, 1), 'a-link/v1')

    it('accepts the link bearer with a valid customer token and names the customer', async () =>
    {
        const authenticator = new CustomerCallAuthenticator(credential, new TokenVerifier())
        const result = await authenticator.Authenticate(CustomerCallAuthenticator.Headers(credential, 'good-token'), true)
        assert.equal(result.Outcome, CustomerCallOutcome.Accepted)
        assert.equal(result.Customer?.Subject, 'u1')
    })

    it('is unauthorized without the link bearer, before looking at the token', async () =>
    {
        const verifier = new TokenVerifier()
        const authenticator = new CustomerCallAuthenticator(credential, verifier)
        const other = InternalApiCredential.FromSecret(Buffer.alloc(32, 1), 'b-link/v1')
        assert.equal((await authenticator.Authenticate(CustomerCallAuthenticator.Headers(other, 'good-token'), true)).Outcome, CustomerCallOutcome.Unauthorized)
        assert.equal((await authenticator.Authenticate({ 'x-pragmatic-customer-token': 'good-token' }, true)).Outcome, CustomerCallOutcome.Unauthorized)
        assert.deepEqual(verifier.Seen, [])
    })

    it('is not signed in with a missing, oversized or invalid token', async () =>
    {
        const authenticator = new CustomerCallAuthenticator(credential, new TokenVerifier())
        assert.equal((await authenticator.Authenticate(CustomerCallAuthenticator.Headers(credential, undefined), true)).Outcome, CustomerCallOutcome.NotSignedIn)
        assert.equal((await authenticator.Authenticate(CustomerCallAuthenticator.Headers(credential, 'bad'), true)).Outcome, CustomerCallOutcome.NotSignedIn)
        assert.equal((await authenticator.Authenticate(CustomerCallAuthenticator.Headers(credential, 'x'.repeat(20000)), true)).Outcome, CustomerCallOutcome.NotSignedIn)
    })

    it('checks only the service when no customer is needed', async () =>
    {
        const authenticator = new CustomerCallAuthenticator(credential, new TokenVerifier())
        const result = await authenticator.Authenticate(CustomerCallAuthenticator.Headers(credential, undefined), false)
        assert.equal(result.Outcome, CustomerCallOutcome.Accepted)
        assert.equal(result.Customer, undefined)
    })
})
