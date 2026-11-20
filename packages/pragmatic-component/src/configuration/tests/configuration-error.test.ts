import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ConfigurationError, ConfigurationErrorCode } from '../configuration-error.js';

describe('ConfigurationError', () =>
{
    it('carries a fixed, distinct message for every code', () =>
    {
        const messages = Object.values(ConfigurationErrorCode).map(code => new ConfigurationError('/options', code).Message);
        assert.ok(messages.every(message => message.length > 0));
        assert.equal(new Set(messages).size, messages.length);
    });

    it('is immutable and prints its path with the message', () =>
    {
        const error = new ConfigurationError('/options/google', ConfigurationErrorCode.UnknownOption);
        assert.equal(Object.isFrozen(error), true);
        assert.equal(String(error), `/options/google ${error.Message}`);
    });
});
