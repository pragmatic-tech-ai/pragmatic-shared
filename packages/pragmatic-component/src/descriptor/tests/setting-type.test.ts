import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SettingType, SettingValues } from '../setting-type.js';

describe('SettingValues', () =>
{
    it('knows the setting types by their JSON names', () =>
    {
        assert.deepEqual(Object.values(SettingType), ['string', 'integer', 'boolean', 'url', 'duration', 'list']);
        assert.equal(SettingValues.IsType('url'), true);
        assert.equal(SettingValues.IsType('secret-reference'), false);
    });

    it('accepts the values of each type', () =>
    {
        const accepted: [SettingType, unknown][] = [
            [SettingType.String, ''], [SettingType.Integer, -3], [SettingType.Boolean, true], [SettingType.Url, 'postgres://db:5432/x'],
            [SettingType.Duration, '250ms'], [SettingType.Duration, '30s'], [SettingType.Duration, '7d'], [SettingType.List, []],
        ];
        for (const [type, value] of accepted)
        {
            assert.equal(SettingValues.Accepts(type, value), true, `${type} ${JSON.stringify(value)}`);
        }
    });

    it('refuses values of another type', () =>
    {
        const refused: [SettingType, unknown][] = [
            [SettingType.String, null], [SettingType.Integer, 2 ** 53], [SettingType.Integer, Number.NaN], [SettingType.Boolean, 0],
            [SettingType.Url, '/relative'], [SettingType.Duration, '1.5h'], [SettingType.Duration, 'h'], [SettingType.List, [null]],
        ];
        for (const [type, value] of refused)
        {
            assert.equal(SettingValues.Accepts(type, value), false, `${type} ${String(value)}`);
        }
    });
});
