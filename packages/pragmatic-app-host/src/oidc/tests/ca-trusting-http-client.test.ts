import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CaTrustingHttpClient } from '../ca-trusting-http-client.js'

test('only https URLs are permitted, and the refusal names no URL', async () =>
{
    const client = new CaTrustingHttpClient(Buffer.from(''))
    await assert.rejects(client.GetJson('http://idp.example/secret-path'), (err: Error) => !err.message.includes('secret-path'))
    await assert.rejects(client.PostForm('http://idp.example/token', new Map([['client_secret', 'shh']])), (err: Error) => !err.message.includes('shh'))
})

test('a request that cannot connect fails with the fixed message, carrying neither the URL nor the posted fields', async () =>
{
    const client = new CaTrustingHttpClient(Buffer.from(''))
    await assert.rejects(client.PostForm('https://127.0.0.1:1/token', new Map([['code', 'the-code']])), (err: Error) => err.message === 'oidc http client: request failed')
})
