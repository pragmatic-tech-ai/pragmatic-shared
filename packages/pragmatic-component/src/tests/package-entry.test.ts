import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as component from '../index.js';
import { RealmSignInDescriptor } from './fixtures/realm-sign-in-descriptor.js';

describe('package entry', () =>
{
    it('exports the descriptor, schema, validator and secret reference surface', () =>
    {
        for (const name of ['ComponentDescriptor', 'ComponentDescriptorBuilder', 'ComponentDescriptorCodec', 'ConfigurationSchema', 'ConfigurationValidator', 'SecretReference', 'SettingType'])
        {
            assert.ok(name in component, name);
        }
    });

    it('validates a configuration end to end through the entry point', () =>
    {
        const text = component.ComponentDescriptorCodec.Serialize(RealmSignInDescriptor.Build());
        const descriptor = component.ComponentDescriptorCodec.Parse(text);
        const result = new component.ConfigurationValidator(descriptor).Validate({ options: { entra: { tenantId: 't', clientId: 'c', clientSecret: 'secret:realm/entra' } } });
        assert.equal(result.Valid, true);
        assert.equal(result.Configuration?.Value('entra', 'authority'), 'https://login.microsoftonline.com');
    });
});
