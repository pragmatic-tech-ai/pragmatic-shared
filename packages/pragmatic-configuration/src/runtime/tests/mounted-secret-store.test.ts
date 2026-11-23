import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MountedSecretStore } from '../mounted-secret-store.js';
import { StartFixture } from './start-fixture.js';

test('a mounted secret is the file of its name; an absent one is null', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        await writeFile(join(folder, 'agent-token'), 'value-1');
        const store = new MountedSecretStore(folder);
        assert.equal(await store.Get('agent-token'), 'value-1');
        assert.equal(await store.Get('absent'), null);
    });
});

test('a name that leaves the directory is never read', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        await mkdir(join(folder, 'inner'));
        await writeFile(join(folder, 'outside'), 'not yours');
        const store = new MountedSecretStore(join(folder, 'inner'));
        for (const name of ['../outside', '..', '.hidden', 'a/b', 'a\\b', ''])
        {
            assert.equal(await store.Get(name), null, name);
        }
    });
});

test('the mounted store is read-only', async () =>
{
    const store = new MountedSecretStore('/nowhere');
    await assert.rejects(store.Put());
    await assert.rejects(store.Delete());
});
