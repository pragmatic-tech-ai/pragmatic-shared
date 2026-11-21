import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InternalApiCredential, InternalApiSecretError } from '../internal-api-credential.js'

class Secrets
{
    public static readonly Strong = Buffer.alloc(32, 7)
    public static readonly Other = Buffer.alloc(32, 9)
}

describe('InternalApiCredential', () =>
{
    const folder = mkdtempSync(join(tmpdir(), 'internal-credential-'))
    after(() => rmSync(folder, { recursive: true, force: true }))

    it('puts HMAC-SHA256(secret, label) on the wire, never the secret', () =>
    {
        const credential = InternalApiCredential.FromSecret(Secrets.Strong, 'link-a/v1')
        const expected = createHmac('sha256', Secrets.Strong).update('link-a/v1').digest('base64url')
        assert.equal(credential.Bearer(), expected)
        assert.ok(!credential.Bearer().includes(Secrets.Strong.toString('base64url')))
    })

    it('defaults to the label of the edge to admin internal API, so both ends interoperate', () =>
    {
        const credential = InternalApiCredential.FromSecret(Secrets.Strong)
        assert.equal(credential.Bearer(), createHmac('sha256', Secrets.Strong).update('pragmatic-internal-api/v1').digest('base64url'))
        assert.equal(InternalApiCredential.DefaultLabel, 'pragmatic-internal-api/v1')
    })

    it('gives two links on one secret two different bearers', () =>
    {
        const a = InternalApiCredential.FromSecret(Secrets.Strong, 'link-a/v1')
        const b = InternalApiCredential.FromSecret(Secrets.Strong, 'link-b/v1')
        assert.notEqual(a.Bearer(), b.Bearer())
        assert.equal(a.Matches(b.Bearer()), false)
    })

    it('matches its own bearer only', () =>
    {
        const credential = InternalApiCredential.FromSecret(Secrets.Strong, 'link-a/v1')
        assert.equal(credential.Matches(credential.Bearer()), true)
        assert.equal(credential.Matches(InternalApiCredential.FromSecret(Secrets.Other, 'link-a/v1').Bearer()), false)
        assert.equal(credential.Matches(''), false)
        assert.equal(credential.Matches('x'.repeat(5000)), false)
    })

    it('reads an authorization header', () =>
    {
        const credential = InternalApiCredential.FromSecret(Secrets.Strong, 'link-a/v1')
        assert.equal(credential.MatchesAuthorization('Bearer ' + credential.Bearer()), true)
        assert.equal(credential.MatchesAuthorization(credential.Bearer()), false)
        assert.equal(credential.MatchesAuthorization('Basic ' + credential.Bearer()), false)
        assert.equal(credential.MatchesAuthorization(undefined), false)
        assert.equal(credential.AuthorizationValue(), 'Bearer ' + credential.Bearer())
    })

    it('reads the secret from a file and refuses a short or missing one without naming it', () =>
    {
        const good = join(folder, 'good')
        writeFileSync(good, Secrets.Strong)
        assert.equal(InternalApiCredential.FromFile(good, 'l').Bearer(), InternalApiCredential.FromSecret(Secrets.Strong, 'l').Bearer())
        const short = join(folder, 'short')
        writeFileSync(short, 'tooshort')
        assert.throws(() => InternalApiCredential.FromFile(short, 'l'), (err: unknown) => err instanceof InternalApiSecretError && !err.message.includes('tooshort'))
        assert.throws(() => InternalApiCredential.FromFile(join(folder, 'missing'), 'l'), InternalApiSecretError)
        assert.throws(() => InternalApiCredential.FromSecret(Buffer.alloc(31), 'l'), InternalApiSecretError)
    })

    it('refuses an empty label', () =>
    {
        assert.throws(() => InternalApiCredential.FromSecret(Secrets.Strong, ''), InternalApiSecretError)
    })
})
