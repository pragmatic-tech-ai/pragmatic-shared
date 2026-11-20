import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaTrustingHttpClient } from "../ca-trusting-http-client.js";
import { FetchHttpClient } from "../fetch-http-client.js";
import { OidcHttpClients } from "../oidc-http-clients.js";
import { TlsTestRealm } from "../../testing/tls-test-realm.js";

test("only https URLs are permitted, and the refusal names no URL", async () =>
{
    const client = new CaTrustingHttpClient(Buffer.from(""));
    await assert.rejects(client.GetJson("http://idp.example/secret-path"), (err: Error) => !err.message.includes("secret-path"));
    await assert.rejects(client.PostForm("http://idp.example/token", new Map([["client_secret", "shh"]])), (err: Error) => !err.message.includes("shh"));
});

test("a request that cannot connect fails with the fixed message, carrying neither the URL nor the posted fields", async () =>
{
    const client = new CaTrustingHttpClient(Buffer.from(""));
    await assert.rejects(client.PostForm("https://127.0.0.1:1/token", new Map([["code", "the-code"]])), (err: Error) => err.message === "oidc http client: request failed");
});

test("a realm on a private CA is reached when its CA bundle file is trusted (GET with a bearer, form POST)", async () =>
{
    const realm = await TlsTestRealm.Start();
    try
    {
        const client = CaTrustingHttpClient.FromFile(TlsTestRealm.CaFile);
        assert.deepEqual(await client.GetJson(realm.Url("/doc"), "the-bearer"), { path: "/doc", method: "GET", authorization: "Bearer the-bearer" });
        assert.deepEqual(await client.PostForm(realm.Url("/token"), new Map([["a", "1"]])), { path: "/token", method: "POST", body: "a=1" });
    }
    finally
    {
        await realm.Stop();
    }
});

test("the same realm is refused without its CA: by the public roots alone and by plain fetch", async () =>
{
    const realm = await TlsTestRealm.Start();
    try
    {
        await assert.rejects(new CaTrustingHttpClient(Buffer.from("")).GetJson(realm.Url("/doc")));
        await assert.rejects(new FetchHttpClient().GetJson(realm.Url("/doc")));
    }
    finally
    {
        await realm.Stop();
    }
});

test("a CA bundle file that is missing or holds no certificate is refused at construction", () =>
{
    const dir = mkdtempSync(join(tmpdir(), "ca-bundle-"));
    const empty = join(dir, "empty.pem");
    writeFileSync(empty, "not a certificate\n");
    assert.throws(() => CaTrustingHttpClient.FromFile(join(dir, "missing.pem")), /CA bundle/);
    assert.throws(() => CaTrustingHttpClient.FromFile(empty), /CA bundle/);
});

test("OidcHttpClients: fetch without a CA bundle, the CA-trusting client with one", () =>
{
    assert.ok(OidcHttpClients.Create(undefined) instanceof FetchHttpClient);
    assert.ok(OidcHttpClients.Create("") instanceof FetchHttpClient);
    assert.ok(OidcHttpClients.Create(TlsTestRealm.CaFile) instanceof CaTrustingHttpClient);
});
