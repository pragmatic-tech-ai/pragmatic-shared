import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SecretReference } from '../secret-reference.js';

describe('SecretReference', () =>
{
    it('formats store and name as secret:<store>/<name>', () =>
    {
        assert.equal(new SecretReference('realm', 'google-client-secret').Format(), 'secret:realm/google-client-secret');
    });

    it('formats an optional version after @', () =>
    {
        assert.equal(new SecretReference('realm', 'entra/client', '3').Format(), 'secret:realm/entra/client@3');
    });

    it('parses what it formats', () =>
    {
        const reference = SecretReference.Parse('secret:vault/oidc/client-secret@v2');
        assert.equal(reference.Store, 'vault');
        assert.equal(reference.Name, 'oidc/client-secret');
        assert.equal(reference.Version, 'v2');
        assert.equal(reference.Format(), 'secret:vault/oidc/client-secret@v2');
    });

    it('parses a reference without a version', () =>
    {
        const reference = SecretReference.Parse('secret:realm/x');
        assert.equal(reference.Version, undefined);
    });

    it('refuses malformed references', () =>
    {
        for (const text of ['realm/x', 'secret:', 'secret:realm', 'secret:realm/', 'secret:/x', 'secret:Realm/x', 'secret:realm/x@', 'secret:realm/x@a@b', 'secret:realm/x y'])
        {
            assert.throws(() => SecretReference.Parse(text), /secret reference/, text);
            assert.equal(SecretReference.TryParse(text), undefined, text);
        }
    });

    it('refuses invalid parts at construction', () =>
    {
        assert.throws(() => new SecretReference('', 'x'));
        assert.throws(() => new SecretReference('realm', ''));
        assert.throws(() => new SecretReference('realm', 'x', ''));
    });

    it('recognises the reference form by its scheme', () =>
    {
        assert.equal(SecretReference.LooksLikeReference('secret:anything'), true);
        assert.equal(SecretReference.LooksLikeReference('hunter2'), false);
    });

    it('compares by value', () =>
    {
        assert.equal(new SecretReference('realm', 'x').Equals(SecretReference.Parse('secret:realm/x')), true);
        assert.equal(new SecretReference('realm', 'x', '1').Equals(new SecretReference('realm', 'x')), false);
    });

    it('is immutable', () =>
    {
        const reference = new SecretReference('realm', 'x');
        assert.equal(Object.isFrozen(reference), true);
    });
});
