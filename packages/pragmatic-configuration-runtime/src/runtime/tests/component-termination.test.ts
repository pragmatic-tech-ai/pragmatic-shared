import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComponentTermination } from '../component-termination.js';

test('the longest configurable drain ends inside the termination grace period, leaving time for what follows it', () =>
{
    assert.equal(ComponentTermination.GracePeriodSeconds, 30);
    assert.equal(ComponentTermination.LongestDrainMs, 25000);
    assert.ok(ComponentTermination.LongestDrainMs + ComponentTermination.AfterDrainSeconds * 1000 <= ComponentTermination.GracePeriodSeconds * 1000);
});
