import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ProtocolDecodeError } from '../../wire/protocol-decode-error.js'
import { CloseStream, OpenStream, StreamCloseReason, StreamOpened, TunnelFrames, TunnelHello, TunnelReady } from '../tunnel.js'

describe('TunnelHello', () =>
{
    it('lists at least one SNI name, each one label under the hive domain', () =>
    {
        assert.deepEqual(TunnelHello.Create(['acme.hives.pragmatic-tech.ai'], '0.10.0').Names, ['acme.hives.pragmatic-tech.ai'])
        assert.throws(() => TunnelHello.Create([], '0.10.0'), ProtocolDecodeError)
        assert.throws(() => TunnelHello.Create(['acme.example.com'], '0.10.0'), ProtocolDecodeError)
        assert.throws(() => TunnelHello.Create(['acme.hives.pragmatic-tech.ai', 'acme.hives.pragmatic-tech.ai'], '0.10.0'), ProtocolDecodeError)
    })
})

describe('TunnelFrames', () =>
{
    it('round-trips every control frame through its text', () =>
    {
        const frames = [
            new TunnelReady(['acme.hives.pragmatic-tech.ai']),
            new OpenStream(1, 'acme.hives.pragmatic-tech.ai'),
            new StreamOpened(1),
            new CloseStream(1, StreamCloseReason.Done),
        ]
        for (const frame of frames)
        {
            assert.deepEqual(TunnelFrames.Decode(TunnelFrames.Encode(frame)).ToJson(), frame.ToJson())
        }
    })

    it('refuses unknown frames, extra members (no client address), bad stream ids and oversized text', () =>
    {
        assert.throws(() => TunnelFrames.Parse({ Frame: 'data', StreamId: 1 }), ProtocolDecodeError)
        assert.throws(() => TunnelFrames.Parse({ Frame: 'open-stream', StreamId: 1, Name: 'acme.hives.pragmatic-tech.ai', ClientAddress: '198.51.100.4' }), ProtocolDecodeError)
        assert.throws(() => TunnelFrames.Parse({ Frame: 'stream-opened', StreamId: 0 }), ProtocolDecodeError)
        assert.throws(() => TunnelFrames.Parse({ Frame: 'stream-opened', StreamId: 2 ** 31 }), ProtocolDecodeError)
        assert.throws(() => TunnelFrames.Parse({ Frame: 'close-stream', StreamId: 1, Reason: 'peer reset by 10.0.0.3' }), ProtocolDecodeError)
        assert.throws(() => TunnelFrames.Decode(JSON.stringify({ Frame: 'ready', Names: ['x'.repeat(TunnelFrames.MaxBytes)] })), ProtocolDecodeError)
    })
})
