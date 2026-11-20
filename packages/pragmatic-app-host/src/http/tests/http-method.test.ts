import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HttpMethod, HttpMethods } from '../http-method.js'

test('only GET, HEAD and OPTIONS are safe: every other verb (PATCH and unknown ones too) is a mutation', () =>
{
    assert.equal(HttpMethods.IsMutating('GET'), false)
    assert.equal(HttpMethods.IsMutating('head'), false)
    assert.equal(HttpMethods.IsMutating('OPTIONS'), false)
    for (const verb of ['POST', 'PUT', 'DELETE', 'PATCH', 'PURGE'])
    {
        assert.equal(HttpMethods.IsMutating(verb), true, verb)
    }
})

test('Parse maps a request method to the enum, case-insensitively; an unknown verb is undefined', () =>
{
    assert.equal(HttpMethods.Parse('post'), HttpMethod.Post)
    assert.equal(HttpMethods.Parse('GET'), HttpMethod.Get)
    assert.equal(HttpMethods.Parse('BREW'), undefined)
    assert.equal(HttpMethods.Parse(undefined), undefined)
})
