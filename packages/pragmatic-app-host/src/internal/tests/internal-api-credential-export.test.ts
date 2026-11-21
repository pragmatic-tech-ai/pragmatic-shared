import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as component from '@pragmatic-tech-ai/pragmatic-component'
import * as host from '../../index.js'

describe('InternalApiCredential re-export', () =>
{
    it('is pragmatic-component\'s class itself, so a credential from either entry is one type', () =>
    {
        assert.equal(host.InternalApiCredential, component.InternalApiCredential)
        assert.equal(host.InternalApiSecretError, component.InternalApiSecretError)
    })
})
