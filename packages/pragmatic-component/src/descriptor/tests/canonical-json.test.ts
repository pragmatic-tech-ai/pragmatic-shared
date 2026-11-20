import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { CanonicalJson } from '../canonical-json.js';

describe('CanonicalJson', () =>
{
    it('sorts object keys recursively and writes no whitespace', () =>
    {
        assert.equal(CanonicalJson.Stringify({ b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } }), '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
    });

    it('keeps array order', () =>
    {
        assert.equal(CanonicalJson.Stringify(['b', 'a']), '["b","a"]');
    });

    it('is independent of insertion order', () =>
    {
        assert.equal(CanonicalJson.Stringify({ x: 1, y: 2 }), CanonicalJson.Stringify({ y: 2, x: 1 }));
    });

    it('refuses values JSON cannot carry', () =>
    {
        assert.throws(() => CanonicalJson.Stringify(Number.NaN));
        assert.throws(() => CanonicalJson.Stringify({ a: undefined }));
        assert.throws(() => CanonicalJson.Stringify(() => 1));
    });

    it('digests as sha256:<hex> of the canonical text', () =>
    {
        // sha256("{}")
        assert.equal(CanonicalJson.Digest({}), 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
    });
});
