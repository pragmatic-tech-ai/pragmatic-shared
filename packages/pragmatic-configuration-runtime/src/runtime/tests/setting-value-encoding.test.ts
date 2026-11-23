import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettingType } from '@pragmatic-tech-ai/pragmatic-component';
import { SettingValueEncoding } from '../setting-value-encoding.js';

test('each setting type encodes as its variable text', () =>
{
    const table: ReadonlyArray<[SettingType, unknown, string]> = [
        [SettingType.String, 'a b,c', 'a b,c'],
        [SettingType.Url, 'https://x.example/a?b=1', 'https://x.example/a?b=1'],
        [SettingType.Duration, '30s', '30s'],
        [SettingType.Integer, 15000, '15000'],
        [SettingType.Integer, -3, '-3'],
        [SettingType.Boolean, true, 'true'],
        [SettingType.Boolean, false, 'false'],
        [SettingType.List, ['a', 'b,c'], '["a","b,c"]'],
        [SettingType.List, [], '[]'],
    ];
    for (const [type, value, text] of table)
    {
        assert.equal(SettingValueEncoding.Encode(type, value), text, `${type} ${JSON.stringify(value)}`);
    }
});

test('a value of the wrong type is refused, not coerced', () =>
{
    assert.throws(() => SettingValueEncoding.Encode(SettingType.Integer, 1.5));
    assert.throws(() => SettingValueEncoding.Encode(SettingType.Boolean, 'false'));
    assert.throws(() => SettingValueEncoding.Encode(SettingType.List, ['a', 1]));
    assert.throws(() => SettingValueEncoding.Encode(SettingType.String, 3));
});

test('a list item with a comma round-trips through the variable', () =>
{
    const items = ['a', 'b,c', ' d '];
    assert.deepEqual(SettingValueEncoding.ReadList(SettingValueEncoding.Encode(SettingType.List, items)), items);
    assert.deepEqual(SettingValueEncoding.ReadList('[]'), []);
});

test('the list reader keeps the hand-written comma form and refuses bad array text', () =>
{
    assert.deepEqual(SettingValueEncoding.ReadList('a, b ,,c'), ['a', 'b', 'c']);
    assert.deepEqual(SettingValueEncoding.ReadList(''), []);
    assert.equal(SettingValueEncoding.ReadList('[1,2]'), undefined);
    assert.equal(SettingValueEncoding.ReadList('["a",'), undefined);
});
