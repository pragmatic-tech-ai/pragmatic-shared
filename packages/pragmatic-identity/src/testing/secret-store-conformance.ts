import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { ISecretStore } from "../authn/secret-store.js";

/** One backing store (a file, a database) that a secret store implementation is opened over, possibly many times. */
export interface ISecretStoreConformanceFixture
{
    /** Opens the implementation over this fixture's backing store, sealed under the 32-byte `masterKey`. */
    Open(masterKey: Buffer): Promise<ISecretStore>;
    /** Everything the backing store persisted, as text (to prove no plaintext is at rest). */
    RawContents(): Promise<string>;
}

/** Behaviour every persistent, encrypted ISecretStore shares (file-encrypted, SQL): round-trip, absence is null,
 *  overwrite, delete, persistence across reopen, fail-closed on a wrong master key, no plaintext at rest. */
export class SecretStoreConformance
{
    private static readonly KeyLength = 32;
    private static readonly Plain = "conformance-plaintext-7f3a";
    private static readonly Unicode = "pässwörd \u{1F511} 秘密";

    public static Describe(label: string, makeFixture: () => Promise<ISecretStoreConformanceFixture>): void
    {
        test(`${label}: Put then Get round-trips the plaintext`, async () =>
        {
            const store = await (await makeFixture()).Open(SecretStoreConformance.Key());
            await store.Put("ref-1", SecretStoreConformance.Plain);
            assert.equal(await store.Get("ref-1"), SecretStoreConformance.Plain);
        });

        test(`${label}: Get on an unknown reference returns null`, async () =>
        {
            const store = await (await makeFixture()).Open(SecretStoreConformance.Key());
            assert.equal(await store.Get("missing"), null);
        });

        test(`${label}: Put overwrites, and references are independent`, async () =>
        {
            const store = await (await makeFixture()).Open(SecretStoreConformance.Key());
            await store.Put("ref-1", "first");
            await store.Put("ref-2", "other");
            await store.Put("ref-1", "second");
            assert.equal(await store.Get("ref-1"), "second");
            assert.equal(await store.Get("ref-2"), "other");
        });

        test(`${label}: Delete removes the secret; deleting an absent reference does not throw`, async () =>
        {
            const store = await (await makeFixture()).Open(SecretStoreConformance.Key());
            await store.Put("ref-1", "gone soon");
            await store.Delete("ref-1");
            assert.equal(await store.Get("ref-1"), null);
            await store.Delete("never-there");
        });

        test(`${label}: empty and non-ASCII secrets round-trip`, async () =>
        {
            const store = await (await makeFixture()).Open(SecretStoreConformance.Key());
            await store.Put("empty", "");
            await store.Put("unicode", SecretStoreConformance.Unicode);
            assert.equal(await store.Get("empty"), "");
            assert.equal(await store.Get("unicode"), SecretStoreConformance.Unicode);
        });

        test(`${label}: reopening over the same backing store and key recovers the secret`, async () =>
        {
            const fixture = await makeFixture();
            const key = SecretStoreConformance.Key();
            await (await fixture.Open(key)).Put("ref-1", SecretStoreConformance.Plain);
            const reopened = await fixture.Open(Buffer.from(key));
            assert.equal(await reopened.Get("ref-1"), SecretStoreConformance.Plain);
        });

        test(`${label}: a wrong master key fails closed (Get returns null, no throw)`, async () =>
        {
            const fixture = await makeFixture();
            await (await fixture.Open(SecretStoreConformance.Key())).Put("ref-1", SecretStoreConformance.Plain);
            const wrong = await fixture.Open(SecretStoreConformance.Key());
            assert.equal(await wrong.Get("ref-1"), null);
        });

        test(`${label}: plaintext never reaches the backing store`, async () =>
        {
            const fixture = await makeFixture();
            await (await fixture.Open(SecretStoreConformance.Key())).Put("ref-1", SecretStoreConformance.Plain);
            const raw = await fixture.RawContents();
            assert.ok(raw.length > 0, "the backing store holds the sealed secret");
            assert.ok(!raw.includes(SecretStoreConformance.Plain));
        });
    }

    private static Key(): Buffer
    {
        return randomBytes(SecretStoreConformance.KeyLength);
    }
}
