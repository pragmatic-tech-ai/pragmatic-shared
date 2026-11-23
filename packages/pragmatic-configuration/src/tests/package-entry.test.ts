import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as entry from '../index.js';

test('the package entry exports the repository, the applied object and the runtime reader', () =>
{
    for (const name of [
        'ConfigurationScope', 'ConfigurationVersion', 'ConfigurationSaveRequest', 'ApplyOutcome', 'ApplyRecord', 'ApplyRequest', 'ApplyTarget',
        'InMemoryConfigurationRepository', 'SqlConfigurationRepository', 'SqlConfigurationMigrations', 'ConfigurationHeadMovedError',
        'ConfigurationRejectedError', 'AppliedConfiguration', 'AppliedConfigurationCodec', 'AppliedConfigurationKeys',
        'ConfigurationRuntimeReader', 'ConfigurationStartError', 'RuntimeConfiguration', 'SecretStoreDirectory', 'SecretValue',
        'SettingValueEncoding', 'SecretVariable', 'MountedSecretStore', 'ConfigurationEnvironmentOverlay', 'ComponentStartConfiguration', 'ComponentStartReport',
    ])
    {
        assert.ok(name in entry, name);
    }
});
