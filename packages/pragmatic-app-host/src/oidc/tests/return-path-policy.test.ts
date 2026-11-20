import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ReturnPathPolicy } from '../return-path-policy.js'

describe('ReturnPathPolicy', () =>
{
    const policy = new ReturnPathPolicy(['/register', '/projects/'])

    it('admits a relative path under an allow-listed prefix, its query kept', () =>
    {
        assert.equal(policy.Admit('/register'), '/register')
        assert.equal(policy.Admit('/register/step-2?plan=pro'), '/register/step-2?plan=pro')
        assert.equal(policy.Admit('/projects/acme'), '/projects/acme')
    })

    it('a prefix matches at a segment boundary only', () =>
    {
        assert.equal(policy.Admit('/registered'), null)
        assert.equal(policy.Admit('/projects'), null)
        assert.equal(policy.Admit('/projectsx/a'), null)
    })

    it('refuses anything that is not a plain same-origin path', () =>
    {
        for (const raw of [
            '', 'register', 'https://evil.example/register', '//evil.example/register', '/\\evil.example', '\\\\evil.example',
            '/register\\..\\admin', '/register/../admin', '/register/./x', '/%2e%2e/register', '/register%2f..%2fadmin',
            '/register%5cx', '/register#frag', '/register x', '/register\n', '/register\u0000', 'javascript:alert(1)',
            '/register/' + 'a'.repeat(2048),
        ])
        {
            assert.equal(policy.Admit(raw), null, raw)
        }
    })

    it('admits nothing without prefixes, and refuses a prefix that is not a plain absolute path', () =>
    {
        assert.equal(new ReturnPathPolicy([]).Admit('/register'), null)
        for (const prefix of ['', 'register', '//evil.example', 'https://evil.example/', '/a/../b', '/a?b'])
        {
            assert.throws(() => new ReturnPathPolicy([prefix]), /return path prefix/, prefix)
        }
    })

    it('the root prefix admits every plain path', () =>
    {
        const any = new ReturnPathPolicy(['/'])
        assert.equal(any.Admit('/'), '/')
        assert.equal(any.Admit('/settings/profile?tab=keys'), '/settings/profile?tab=keys')
        assert.equal(any.Admit('//evil.example'), null)
    })
})
