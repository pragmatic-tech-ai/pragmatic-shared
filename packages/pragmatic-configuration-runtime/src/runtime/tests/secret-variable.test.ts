import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SecretVariable } from '../secret-variable.js';
import { StartFixture } from './start-fixture.js';

test('the _FILE variable wins over the plain one, without its trailing line break', async () =>
{
    await StartFixture.InFolder(async folder =>
    {
        const file = join(folder, 'token');
        await writeFile(file, 'from-file\n');
        assert.equal(SecretVariable.Read({ TEST_TOKEN: 'from-env', TEST_TOKEN_FILE: file }, 'TEST_TOKEN'), 'from-file');
    });
});

test('without a file the plain variable is read; empty reads as none', () =>
{
    assert.equal(SecretVariable.Read({ TEST_TOKEN: 'from-env' }, 'TEST_TOKEN'), 'from-env');
    assert.equal(SecretVariable.Read({ TEST_TOKEN: '' }, 'TEST_TOKEN'), undefined);
    assert.equal(SecretVariable.Read({ TEST_TOKEN_FILE: '' }, 'TEST_TOKEN'), undefined);
    assert.equal(SecretVariable.Read({}, 'TEST_TOKEN'), undefined);
});

test('an unreadable file throws naming the variable', () =>
{
    assert.throws(() => SecretVariable.Read({ TEST_TOKEN_FILE: '/nowhere/token' }, 'TEST_TOKEN'), /TEST_TOKEN_FILE/);
});
