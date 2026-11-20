import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { HostFixture } from '../../tests/support/host-fixture.js'
import { HttpMethod } from '../../http/http-method.js'
import { RouteAuth } from '../../routing/route.js'
import { InternalApiCredential } from '../internal-api-credential.js'
import { InternalApiGuard } from '../internal-api-guard.js'

describe('InternalApiGuard', () =>
{
    const credential = InternalApiCredential.FromSecret(Buffer.alloc(32, 3), 'test-link/v1')
    let fixture: HostFixture

    beforeEach(async () =>
    {
        fixture = new HostFixture()
        const guard = new InternalApiGuard(credential)
        fixture.Routes.Add({ Method: HttpMethod.Post, Pattern: '/internal/thing', Auth: RouteAuth.Public, Handler: async ctx =>
        {
            guard.Require(ctx)
            ctx.WriteJson(200, { ok: true })
        } })
        await fixture.Start()
    })

    afterEach(async () => await fixture.Stop())

    it('lets the link bearer through', async () =>
    {
        const answer = await fixture.Send('/internal/thing', { Method: 'POST', Origin: null, Json: {}, Headers: { authorization: credential.AuthorizationValue() } })
        assert.equal(answer.Status, 200)
    })

    it('answers 401 unauthorized without it, or with another link bearer', async () =>
    {
        const other = InternalApiCredential.FromSecret(Buffer.alloc(32, 3), 'other-link/v1')
        for (const headers of [{}, { authorization: other.AuthorizationValue() }, { authorization: credential.Bearer() }])
        {
            const answer = await fixture.Send('/internal/thing', { Method: 'POST', Origin: null, Json: {}, Headers: headers })
            assert.equal(answer.Status, 401)
            assert.deepEqual(answer.Json(), { error: 'Unauthorized', code: 'unauthorized' })
        }
    })
})
