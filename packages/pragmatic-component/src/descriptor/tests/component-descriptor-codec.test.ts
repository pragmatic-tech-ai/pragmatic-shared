import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ComponentDescriptorCodec } from '../component-descriptor-codec.js';
import { ComponentDescriptorError } from '../component-descriptor-error.js';
import { RealmSignInDescriptor } from '../../tests/fixtures/realm-sign-in-descriptor.js';

type MutableJson = Record<string, any>;

class Mutated
{
    /** The realm sign-in descriptor's JSON with one change applied. */
    public static Json(change: (json: MutableJson) => void): MutableJson
    {
        const json = JSON.parse(JSON.stringify(RealmSignInDescriptor.Build().ToJson()));
        change(json);
        return json;
    }

    public static Fails(change: (json: MutableJson) => void, pattern: RegExp): void
    {
        assert.throws(() => ComponentDescriptorCodec.Decode(Mutated.Json(change)), (error: unknown) => error instanceof ComponentDescriptorError && pattern.test(error.message));
    }
}

describe('ComponentDescriptorCodec', () =>
{
    it('round-trips through canonical JSON text', () =>
    {
        const descriptor = RealmSignInDescriptor.Build();
        const text = ComponentDescriptorCodec.Serialize(descriptor);
        assert.equal(text, descriptor.ToCanonicalJson());
        const parsed = ComponentDescriptorCodec.Parse(text);
        assert.deepEqual(parsed.ToJson(), descriptor.ToJson());
        assert.equal(parsed.ContentDigest(), descriptor.ContentDigest());
    });

    it('parses pretty-printed JSON in any key order to the same digest', () =>
    {
        const descriptor = RealmSignInDescriptor.Build();
        const json = descriptor.ToJson() as Record<string, unknown>;
        const reordered = Object.fromEntries(Object.entries(json).reverse());
        assert.equal(ComponentDescriptorCodec.Parse(JSON.stringify(reordered, null, 2)).ContentDigest(), descriptor.ContentDigest());
    });

    it('refuses text that is not JSON', () =>
    {
        assert.throws(() => ComponentDescriptorCodec.Parse('{'), ComponentDescriptorError);
        assert.throws(() => ComponentDescriptorCodec.Parse('[]'), ComponentDescriptorError);
    });

    it('refuses an unknown schema version', () =>
    {
        Mutated.Fails(json => { json.schema = 2; }, /schema/);
    });

    it('refuses unknown keys (they would not survive re-encoding)', () =>
    {
        Mutated.Fails(json => { json.extra = 1; }, /unknown key 'extra'/);
        Mutated.Fails(json => { json.options[0].settings[0].hint = 'x'; }, /unknown key 'hint'/);
        Mutated.Fails(json => { json.endpoints.health.scheme = 'http'; }, /unknown key 'scheme'/);
    });

    it('refuses wrongly typed and missing members', () =>
    {
        Mutated.Fails(json => { json.component = 3; }, /'component'/);
        Mutated.Fails(json => { delete json.version; }, /'version'/);
        Mutated.Fails(json => { json.options = {}; }, /'options'/);
        Mutated.Fails(json => { json.options[0].settings[0].type = 'float'; }, /unknown type/);
        Mutated.Fails(json => { json.options[0].settings[0].required = 'no'; }, /'required'/);
        Mutated.Fails(json => { json.storage.postgres = 1; }, /'postgres'/);
        Mutated.Fails(json => { json.endpoints.ports[0].port = '8080'; }, /'port'/);
        Mutated.Fails(json => { json.roles = null; }, /'roles'/);
    });

    it('applies the builder rules on decode', () =>
    {
        Mutated.Fails(json => { json.options.push(json.options[0]); }, /duplicate option 'local'/);
        Mutated.Fails(json => { json.options[1].settings[1].default = 'literal'; }, /secret setting 'google.clientSecret' cannot have a default/);
    });

    it('decodes roles and an absent health endpoint', () =>
    {
        const json = Mutated.Json(value => { value.roles = [{ name: 'reader', description: 'Reads' }]; delete value.endpoints.health; });
        const descriptor = ComponentDescriptorCodec.Decode(json);
        assert.equal(descriptor.Roles[0].Name, 'reader');
        assert.equal(descriptor.Endpoints.Health, undefined);
    });
});
