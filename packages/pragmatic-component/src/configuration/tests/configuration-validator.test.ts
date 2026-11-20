import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ConfigurationValidator } from '../configuration-validator.js';
import { ConfigurationErrorCode } from '../configuration-error.js';
import { SecretReference } from '../secret-reference.js';
import { RealmSignInDescriptor } from '../../tests/fixtures/realm-sign-in-descriptor.js';

class Fixture
{
    public static readonly Validator = new ConfigurationValidator(RealmSignInDescriptor.Build());

    public static Google(settings: Record<string, unknown>): unknown
    {
        return { options: { google: settings } };
    }

    public static Errors(document: unknown): [string, ConfigurationErrorCode][]
    {
        const result = Fixture.Validator.Validate(document);
        assert.equal(result.Valid, result.Errors.length === 0);
        return result.Errors.map(error => [error.Path, error.Code]);
    }
}

describe('ConfigurationValidator', () =>
{
    it('accepts a valid configuration and resolves defaults', () =>
    {
        const result = Fixture.Validator.Validate({
            options: {
                local: {},
                google: { clientId: 'g-id', clientSecret: 'secret:realm/google-client-secret', allowedDomains: ['pragmatic-tech.ai'] },
                oidc: { issuer: 'https://idp.example.com', clientId: 'o-id' },
            },
        });
        assert.deepEqual(result.Errors, []);
        assert.equal(result.Valid, true);
        const configuration = result.Configuration!;
        assert.deepEqual(configuration.Options, ['local', 'google', 'oidc']);
        assert.equal(configuration.IsEnabled('entra'), false);
        assert.equal(configuration.Value('local', 'selfRegistration'), false);
        assert.equal(configuration.Value('local', 'passwordMinLength'), 12);
        assert.equal(configuration.Value('local', 'sessionLifetime'), '8h');
        assert.deepEqual(configuration.Value('oidc', 'scopes'), ['openid', 'profile', 'email']);
        assert.equal(configuration.Value('oidc', 'clientSecret'), undefined);
        assert.deepEqual(configuration.Value('google', 'allowedDomains'), ['pragmatic-tech.ai']);
        const secret = configuration.Value('google', 'clientSecret');
        assert.ok(secret instanceof SecretReference);
        assert.equal(secret.Format(), 'secret:realm/google-client-secret');
    });

    it('lists the secret references a configuration needs resolved', () =>
    {
        const configuration = Fixture.Validator.Validate({
            options: {
                google: { clientId: 'g', clientSecret: 'secret:realm/g' },
                pragmatic: { clientId: 'p', clientSecret: 'secret:vault/p@2' },
            },
        }).Configuration!;
        assert.deepEqual(configuration.SecretReferences().map(entry => [entry.Option, entry.Setting, entry.Reference.Format()]), [
            ['google', 'clientSecret', 'secret:realm/g'],
            ['pragmatic', 'clientSecret', 'secret:vault/p@2'],
        ]);
    });

    it('writes the resolved configuration as JSON (defaults filled, references formatted)', () =>
    {
        const configuration = Fixture.Validator.Validate({ options: { pragmatic: { clientId: 'p', clientSecret: 'secret:realm/p' } } }).Configuration!;
        assert.deepEqual(configuration.ToJson(), {
            options: { pragmatic: { issuer: 'https://id.pragmatic-tech.ai', clientId: 'p', clientSecret: 'secret:realm/p' } },
        });
    });

    it('accepts an empty configuration (no option enabled)', () =>
    {
        const result = Fixture.Validator.Validate({ options: {} });
        assert.equal(result.Valid, true);
        assert.deepEqual(result.Configuration?.Options, []);
    });

    it('rejects a document that is not an object', () =>
    {
        for (const document of [null, [], 'x', 1])
        {
            assert.deepEqual(Fixture.Errors(document), [['', ConfigurationErrorCode.NotAnObject]]);
        }
        assert.deepEqual(Fixture.Errors({ options: [] }), [['/options', ConfigurationErrorCode.NotAnObject]]);
        assert.deepEqual(Fixture.Errors({ options: { local: true } }), [['/options/local', ConfigurationErrorCode.NotAnObject]]);
    });

    it('rejects a missing options member and unknown top-level members', () =>
    {
        assert.deepEqual(Fixture.Errors({}), [['/options', ConfigurationErrorCode.MissingRequired]]);
        assert.deepEqual(Fixture.Errors({ options: {}, extra: 1 }), [['/extra', ConfigurationErrorCode.UnknownProperty]]);
    });

    it('rejects an unknown option', () =>
    {
        assert.deepEqual(Fixture.Errors({ options: { saml: {} } }), [['/options/saml', ConfigurationErrorCode.UnknownOption]]);
    });

    it('rejects an unknown setting', () =>
    {
        assert.deepEqual(Fixture.Errors({ options: { local: { colour: 'blue' } } }), [['/options/local/colour', ConfigurationErrorCode.UnknownSetting]]);
    });

    it('rejects missing required settings of an enabled option', () =>
    {
        assert.deepEqual(Fixture.Errors(Fixture.Google({})), [
            ['/options/google/clientId', ConfigurationErrorCode.MissingRequired],
            ['/options/google/clientSecret', ConfigurationErrorCode.MissingRequired],
        ]);
    });

    it('rejects values of the wrong type', () =>
    {
        const cases: [string, Record<string, unknown>, string][] = [
            ['local', { selfRegistration: 'yes' }, 'selfRegistration'],
            ['local', { passwordMinLength: 12.5 }, 'passwordMinLength'],
            ['local', { passwordMinLength: '12' }, 'passwordMinLength'],
            ['local', { sessionLifetime: '8 hours' }, 'sessionLifetime'],
            ['local', { sessionLifetime: null }, 'sessionLifetime'],
            ['oidc', { issuer: 'idp.example.com', clientId: 'x' }, 'issuer'],
            ['oidc', { issuer: 'https://idp', clientId: 7 }, 'clientId'],
            ['oidc', { issuer: 'https://idp', clientId: 'x', scopes: 'openid' }, 'scopes'],
            ['oidc', { issuer: 'https://idp', clientId: 'x', scopes: ['openid', 1] }, 'scopes'],
        ];
        for (const [option, settings, setting] of cases)
        {
            assert.deepEqual(Fixture.Errors({ options: { [option]: settings } }), [[`/options/${option}/${setting}`, ConfigurationErrorCode.WrongType]], JSON.stringify(settings));
        }
    });

    it('rejects a literal value in a secret setting', () =>
    {
        assert.deepEqual(Fixture.Errors(Fixture.Google({ clientId: 'g', clientSecret: 'hunter2' })), [['/options/google/clientSecret', ConfigurationErrorCode.LiteralSecret]]);
        assert.deepEqual(Fixture.Errors(Fixture.Google({ clientId: 'g', clientSecret: 42 })), [['/options/google/clientSecret', ConfigurationErrorCode.LiteralSecret]]);
    });

    it('rejects a malformed secret reference', () =>
    {
        assert.deepEqual(Fixture.Errors(Fixture.Google({ clientId: 'g', clientSecret: 'secret:realm' })), [['/options/google/clientSecret', ConfigurationErrorCode.InvalidSecretReference]]);
    });

    it('reports every error with a message, not just the first', () =>
    {
        const result = Fixture.Validator.Validate({ options: { google: { clientSecret: 'plain', extra: 1 }, saml: {} } });
        assert.equal(result.Valid, false);
        assert.equal(result.Configuration, undefined);
        assert.deepEqual(result.Errors.map(error => error.Code), [
            ConfigurationErrorCode.LiteralSecret,
            ConfigurationErrorCode.UnknownSetting,
            ConfigurationErrorCode.MissingRequired,
            ConfigurationErrorCode.UnknownOption,
        ]);
        for (const error of result.Errors)
        {
            assert.ok(error.Message.length > 0);
        }
    });

    it('escapes JSON-pointer characters in paths', () =>
    {
        assert.deepEqual(Fixture.Errors({ options: { 'a/b~c': {} } }), [['/options/a~1b~0c', ConfigurationErrorCode.UnknownOption]]);
    });

    it('never echoes a rejected literal secret in the error', () =>
    {
        const result = Fixture.Validator.Validate(Fixture.Google({ clientId: 'g', clientSecret: 'hunter2' }));
        assert.equal(JSON.stringify(result.Errors).includes('hunter2'), false);
    });
});
