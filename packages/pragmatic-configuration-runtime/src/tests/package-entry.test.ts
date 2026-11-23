import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as entry from '../index.js';

test('the package entry exports the applied object, the runtime reader and the start step', () =>
{
    for (const name of [
        'ConfigurationScope', 'JsonDocument', 'AppliedConfiguration', 'AppliedConfigurationCodec', 'AppliedConfigurationError', 'AppliedConfigurationKeys',
        'ConfigurationRuntimeReader', 'ConfigurationStartError', 'ConfigurationStartReason', 'RuntimeConfiguration', 'SecretStoreDirectory', 'SecretValue',
        'SettingValueEncoding', 'SecretVariable', 'MountedSecretStore', 'ConfigurationEnvironmentOverlay', 'ComponentStartConfiguration', 'ComponentStartReport',
    ])
    {
        assert.ok(name in entry, name);
    }
});

test('the package depends on pragmatic-component alone and has no peer, so a lean container can carry it', () =>
{
    const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')) as { dependencies?: object; peerDependencies?: object };
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ['@pragmatic-tech-ai/pragmatic-component']);
    assert.equal(manifest.peerDependencies, undefined);
});
