import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ComponentDeclarations, SettingType } from '@pragmatic-tech-ai/pragmatic-component';
import type { ComponentDeclaration } from '@pragmatic-tech-ai/pragmatic-component';
import { AppliedConfiguration } from '../../applied/applied-configuration.js';
import { ComponentStartConfiguration } from '../component-start-configuration.js';
import { ConfigurationRuntimeReader } from '../configuration-runtime-reader.js';
import { ConfigurationStartError, ConfigurationStartReason } from '../configuration-start-error.js';
import { DeclaredSourceSecrets } from '../declared-source-secrets.js';
import { StartFixture } from './start-fixture.js';

/** A component whose `core` option the start step overlays and whose `realm` option it reads itself (no sources), its
 *  secrets in a store only the component's own reader has (the realm sign-in service's realm store). */
class DeclaredCase
{
    public static Declaration(): ComponentDeclaration
    {
        return {
            name: 'pragmatic-test-idp',
            version: '0.1.0',
            options: [
                { name: 'core', description: 'The service.', settings: [{ name: 'token', type: SettingType.String, source: 'TEST_TOKEN', secret: true, description: 'Token.' }] },
                { name: 'google', description: 'A realm source.', settings: [{ name: 'clientSecret', type: SettingType.String, secret: true, description: 'Secret.' }] },
            ],
            roles: [],
            postgres: false,
            ports: [],
        };
    }

    public static Applied(core: Record<string, unknown> | undefined): AppliedConfiguration
    {
        const d = ComponentDeclarations.Build(DeclaredCase.Declaration());
        const options: Record<string, unknown> = { google: { clientSecret: 'secret:realm/google-client-secret' } };
        if (core !== undefined) options.core = core;
        return new AppliedConfiguration(StartFixture.Realm, d.Name, 3, d.Version, d.ContentDigest(), { options } as never);
    }
}

test('the start step resolves only the secrets of settings it overlays: a realm-store reference it cannot resolve is left to the component', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const path = await StartFixture.Configuration(folder, DeclaredCase.Applied(undefined));
        const report = await ComponentStartConfiguration.Apply({ Declaration: DeclaredCase.Declaration(), Env: { PRAGMATIC_CONFIGURATION_FILE: path }, Stores: StartFixture.Stores(), SecretsDir: join(folder, 's') });
        assert.equal(report.Version, 3);
    });
});

test('a secret of a setting the start step overlays is still resolved, and refused when its store is unknown', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const path = await StartFixture.Configuration(folder, DeclaredCase.Applied({ token: 'secret:vault/t' }));
        await assert.rejects(
            ComponentStartConfiguration.Apply({ Declaration: DeclaredCase.Declaration(), Env: { PRAGMATIC_CONFIGURATION_FILE: path }, Stores: StartFixture.Stores(), SecretsDir: join(folder, 's') }),
            (error: unknown) => error instanceof ConfigurationStartError && error.Reason === ConfigurationStartReason.UnknownSecretStore);
    });
});

test('a reader without a selection resolves every secret, as before (the realm reader)', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const path = await StartFixture.Configuration(folder, DeclaredCase.Applied(undefined));
        const reader = new ConfigurationRuntimeReader(ComponentDeclarations.Build(DeclaredCase.Declaration()), StartFixture.Stores());
        await assert.rejects(reader.Read(path), (error: unknown) => error instanceof ConfigurationStartError && error.Reason === ConfigurationStartReason.UnknownSecretStore);
        const selected = new ConfigurationRuntimeReader(ComponentDeclarations.Build(DeclaredCase.Declaration()), StartFixture.Stores(), false, new DeclaredSourceSecrets(DeclaredCase.Declaration()));
        const read = await selected.Read(path);
        assert.equal(read.Secret('google', 'clientSecret'), undefined, 'not resolved, so not held');
    });
});
