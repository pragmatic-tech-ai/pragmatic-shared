import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ComponentDescriptorBuilder } from '../component-descriptor-builder.js';
import { CanonicalJson } from '../canonical-json.js';
import { SettingType } from '../setting-type.js';
import { RealmSignInDescriptor } from '../../tests/fixtures/realm-sign-in-descriptor.js';

class RealmSignInGolden
{
    /** Changes only when the descriptor format or the fixture changes; a change here is a deliberate decision. */
    public static readonly Digest = 'sha256:d1f39309f603c3e73c5509215a0de8bb7b5db5bb66ad066c02cf189eb2c829f1';
}

describe('ComponentDescriptor', () =>
{
    it('writes its JSON form', () =>
    {
        const descriptor = new ComponentDescriptorBuilder('app', '1.2.3')
            .Option('core', 'Core', option => option
                .Setting('level', SettingType.String, setting => setting.Default('info').Description('Log level'))
                .Setting('key', SettingType.String, setting => setting.Required().Secret()))
            .Role('reader', 'Reads')
            .Postgres()
            .Port('http', 8080)
            .Health('http', '/healthz')
            .Build();
        assert.deepEqual(descriptor.ToJson(), {
            schema: 1,
            component: 'app',
            version: '1.2.3',
            options: [{
                name: 'core',
                description: 'Core',
                settings: [
                    { name: 'level', type: 'string', required: false, secret: false, default: 'info', description: 'Log level' },
                    { name: 'key', type: 'string', required: true, secret: true, description: '' },
                ],
            }],
            roles: [{ name: 'reader', description: 'Reads' }],
            storage: { postgres: true },
            endpoints: { ports: [{ name: 'http', port: 8080 }], health: { port: 'http', path: '/healthz' } },
        });
    });

    it('omits an absent health endpoint', () =>
    {
        const json = new ComponentDescriptorBuilder('app', '1.0.0').Build().ToJson() as { endpoints: Record<string, unknown> };
        assert.deepEqual(json.endpoints, { ports: [] });
    });

    it('serialises canonically', () =>
    {
        const descriptor = RealmSignInDescriptor.Build();
        assert.equal(descriptor.ToCanonicalJson(), CanonicalJson.Stringify(descriptor.ToJson()));
    });

    it('digests its canonical JSON reproducibly', () =>
    {
        const digest = RealmSignInDescriptor.Build().ContentDigest();
        assert.match(digest, /^sha256:[0-9a-f]{64}$/);
        assert.equal(RealmSignInDescriptor.Build().ContentDigest(), digest);
        assert.equal(digest, CanonicalJson.Digest(RealmSignInDescriptor.Build().ToJson()));
    });

    it('digests differently when anything changes', () =>
    {
        const a = new ComponentDescriptorBuilder('app', '1.0.0').Option('o', '', option => option.Setting('s', SettingType.String)).Build();
        const b = new ComponentDescriptorBuilder('app', '1.0.0').Option('o', '', option => option.Setting('s', SettingType.String, setting => setting.Secret())).Build();
        const c = new ComponentDescriptorBuilder('app', '1.0.1').Option('o', '', option => option.Setting('s', SettingType.String)).Build();
        assert.notEqual(a.ContentDigest(), b.ContentDigest());
        assert.notEqual(a.ContentDigest(), c.ContentDigest());
    });

    it('pins the realm sign-in descriptor (golden digest)', () =>
    {
        assert.equal(RealmSignInDescriptor.Build().ContentDigest(), RealmSignInGolden.Digest);
    });
});
