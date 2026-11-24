import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComponentReadyFile } from '../component-ready-file.js';

test('a component marks itself ready by the file its readiness probe tests for, created once and kept', () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'ready-'));
    try
    {
        const path = join(dir, 'ready');
        const ready = new ComponentReadyFile(path);
        assert.equal(existsSync(path), false);
        ready.Mark();
        ready.Mark();
        assert.equal(existsSync(path), true);
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('the probe command tests for exactly that file, and the default file is outside the configuration mounts', () =>
{
    assert.equal(ComponentReadyFile.DefaultPath, '/tmp/pragmatic-ready');
    assert.deepEqual(ComponentReadyFile.ProbeCommand(), ['test', '-f', '/tmp/pragmatic-ready']);
    assert.deepEqual(new ComponentReadyFile('/x/ready').Command(), ['test', '-f', '/x/ready']);
});
