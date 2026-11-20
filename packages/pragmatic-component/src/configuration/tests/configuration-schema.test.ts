import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ConfigurationSchema } from '../configuration-schema.js';
import { SecretReference } from '../secret-reference.js';
import { CanonicalJson } from '../../descriptor/canonical-json.js';
import { ComponentDescriptorBuilder } from '../../descriptor/component-descriptor-builder.js';
import { SettingType, SettingValues } from '../../descriptor/setting-type.js';
import { RealmSignInDescriptor } from '../../tests/fixtures/realm-sign-in-descriptor.js';

type Schema = Record<string, any>;

describe('ConfigurationSchema', () =>
{
    const schema = new ConfigurationSchema(RealmSignInDescriptor.Build()).ToJson() as Schema;
    const options = schema.properties.options;

    it('is a closed draft 2020-12 object schema identified by component and version', () =>
    {
        assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
        assert.equal(schema.$id, 'urn:pragmatic:component:realm-sign-in:0.3.0:configuration');
        assert.equal(schema.type, 'object');
        assert.equal(schema.additionalProperties, false);
        assert.deepEqual(schema.required, ['options']);
        assert.equal(options.type, 'object');
        assert.equal(options.additionalProperties, false);
        assert.deepEqual(Object.keys(options.properties), ['local', 'google', 'entra', 'oidc', 'pragmatic']);
    });

    it('gives each option a closed object with its required settings', () =>
    {
        const google = options.properties.google;
        assert.equal(google.type, 'object');
        assert.equal(google.description, 'Sign in with Google');
        assert.equal(google.additionalProperties, false);
        assert.deepEqual(google.required, ['clientId', 'clientSecret']);
        assert.equal(options.properties.local.required, undefined);
    });

    it('maps each setting type', () =>
    {
        const local = options.properties.local.properties;
        assert.deepEqual(local.selfRegistration, { type: 'boolean', default: false, description: 'Visitors may create their own account' });
        assert.deepEqual(local.passwordMinLength, { type: 'integer', default: 12 });
        assert.deepEqual(local.sessionLifetime, { type: 'string', pattern: SettingValues.DurationPattern, default: '8h' });
        const oidc = options.properties.oidc.properties;
        assert.deepEqual(oidc.issuer, { type: 'string', format: 'uri' });
        assert.deepEqual(oidc.clientId, { type: 'string' });
        assert.deepEqual(oidc.scopes, { type: 'array', items: { type: 'string' }, default: ['openid', 'profile', 'email'] });
    });

    it('takes a secret reference for a secret setting, never a value', () =>
    {
        assert.deepEqual(options.properties.google.properties.clientSecret, { $ref: '#/$defs/secretReference', description: 'OAuth client secret' });
        assert.deepEqual(schema.$defs.secretReference, { type: 'string', pattern: SecretReference.Pattern, description: 'A reference into the realm secrets home: secret:<store>/<name>[@<version>]' });
    });

    it('omits $defs when no setting is secret', () =>
    {
        const plain = new ConfigurationSchema(new ComponentDescriptorBuilder('app', '1.0.0').Option('o', '', option => option.Setting('s', SettingType.String)).Build()).ToJson() as Schema;
        assert.equal(plain.$defs, undefined);
        assert.equal(plain.properties.options.properties.o.description, undefined);
    });

    it('is deterministic', () =>
    {
        const again = new ConfigurationSchema(RealmSignInDescriptor.Build());
        assert.equal(again.ToCanonicalJson(), CanonicalJson.Stringify(schema));
    });
});
