import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PaddleReference } from '../dto/paddle-reference.js'

describe('PaddleReference', () =>
{
    it('accepts Paddle entity and event ids, and the ids of simulated notification events', () =>
    {
        for (const id of ['evt_01hv8x2acma2gz3he5gxv1fxhz', 'txn_01hv8wptq8987qeep44cyrewp9', 'sub_01h04vsc0qhwtsbsxh3422wjs4', 'ntfsimevt_01j9w7fgxvzjp1hg4jk7c3e8vq'])
        {
            assert.ok(PaddleReference.IdPattern.test(id), id)
        }
    })

    it('refuses anything else: no prefix, an unknown long prefix, upper case, a short body, a path', () =>
    {
        for (const id of ['01hv8x2acma2gz3he5gxv1fxhz', 'notification_01hv8x2acma2gz3he5gxv1fxhz', 'EVT_01hv8x2acma2gz3he5gxv1fxhz', 'evt_short', 'evt_01hv8x2acma2gz3he5gxv1fxhz/../x', 'ntfsim_01hv8x2acma2gz3he5gxv1fxhz'])
        {
            assert.ok(!PaddleReference.IdPattern.test(id), id)
        }
    })
})
