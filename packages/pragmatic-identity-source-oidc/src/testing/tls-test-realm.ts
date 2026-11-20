import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A route a TLS test realm answers with a JSON body. */
export type TlsTestRealmRoute = (req: IncomingMessage, body: string) => unknown;

/**
 * An https server on 127.0.0.1 whose certificate is issued by a test CA (CaPem, valid for 127.0.0.1 and localhost; the
 * key pair exists for tests only): a realm on a private CA. CaFile writes the CA to a temporary PEM file once, the form
 * a CA bundle setting takes. Unrouted requests echo their path, method, bearer and body.
 */
export class TlsTestRealm
{
    private static readonly NewLine = "\n";
    public static readonly CaPem = [
        "-----BEGIN CERTIFICATE-----",
        "MIIBqzCCAVGgAwIBAgIUe0t/peo2jJQ6dGPwCjzqph7vywswCgYIKoZIzj0EAwIw",
        "IjEgMB4GA1UEAwwXUHJhZ21hdGljIFRlc3QgUmVhbG0gQ0EwIBcNMjYxMTIwMTI0",
        "NDA0WhgPMjEyNjEwMjcxMjQ0MDRaMCIxIDAeBgNVBAMMF1ByYWdtYXRpYyBUZXN0",
        "IFJlYWxtIENBMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEr435lavB4Cjd+v4W",
        "0qVpI4YABaTAbp5Iqo/iiqdya9B/QTsOZXBHr8gonBYmzL2Pb0gYHJg7Chx67tlQ",
        "MOi+MKNjMGEwHQYDVR0OBBYEFOZxMa56+YSJDKB7RfTU2hMGE2PKMB8GA1UdIwQY",
        "MBaAFOZxMa56+YSJDKB7RfTU2hMGE2PKMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0P",
        "AQH/BAQDAgEGMAoGCCqGSM49BAMCA0gAMEUCIAqraT4KGc4RBv1vPp33aOqCzmeY",
        "2Q35dR1Ko1qBKwu4AiEAsDWBY0kOv+ttOVLhS41AspL5LZ1OiW5kWlt9W5B3ftI=",
        "-----END CERTIFICATE-----",
    ].join(TlsTestRealm.NewLine) + TlsTestRealm.NewLine;
    private static readonly ServerCertificatePem = [
        "-----BEGIN CERTIFICATE-----",
        "MIIBuDCCAV6gAwIBAgIUR6IO4vJi1p20zDD41N1S1RMS4NAwCgYIKoZIzj0EAwIw",
        "IjEgMB4GA1UEAwwXUHJhZ21hdGljIFRlc3QgUmVhbG0gQ0EwIBcNMjYxMTIwMTI0",
        "NDA0WhgPMjEyNjEwMjcxMjQ0MDRaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDBZMBMG",
        "ByqGSM49AgEGCCqGSM49AwEHA0IABH1l/JoxuG1PUXC/fXGg+V/klYMcS7VLTm59",
        "i9b3xCGInU4q1nnsIJBDDtiZsH7mMcdfncLNQb9daz7A8EGJT/6jfjB8MBoGA1Ud",
        "EQQTMBGHBH8AAAGCCWxvY2FsaG9zdDAJBgNVHRMEAjAAMBMGA1UdJQQMMAoGCCsG",
        "AQUFBwMBMB0GA1UdDgQWBBRqrAVqlUWoC/Fdt904qrZ1NpEENDAfBgNVHSMEGDAW",
        "gBTmcTGuevmEiQyge0X01NoTBhNjyjAKBggqhkjOPQQDAgNIADBFAiEAyS/Xl93e",
        "sLOnBLUSbXqGbx9LJkkCjzKNULrRpYeQVIQCIE1UX4AlpK/AX1RkTG0jZWVdkhPF",
        "MIh4Kgc3gB8H8Tol",
        "-----END CERTIFICATE-----",
    ].join(TlsTestRealm.NewLine) + TlsTestRealm.NewLine;
    private static readonly ServerKeyPem = [
        "-----BEGIN PRIVATE KEY-----",
        "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgNBsQ74bIURAKiuh5",
        "ramjDfoV0o36oRwB3FWuzfyxXVOhRANCAAR9ZfyaMbhtT1Fwv31xoPlf5JWDHEu1",
        "S05ufYvW98QhiJ1OKtZ57CCQQw7YmbB+5jHHX53CzUG/XWs+wPBBiU/+",
        "-----END PRIVATE KEY-----",
    ].join(TlsTestRealm.NewLine) + TlsTestRealm.NewLine;
    private static readonly CaFileName = "test-realm-ca.pem";
    private static readonly TempPrefix = "tls-test-realm-";
    private static caFile: string | undefined;
    private static readonly Host = "127.0.0.1";
    private static readonly JsonType = "application/json";

    public readonly Requests: string[] = [];

    private constructor(private readonly server: Server, private readonly routes: Map<string, TlsTestRealmRoute>)
    {
    }

    public static async Start(routes: Map<string, TlsTestRealmRoute> = new Map()): Promise<TlsTestRealm>
    {
        let realm: TlsTestRealm | undefined;
        const server = createServer({ cert: TlsTestRealm.ServerCertificatePem, key: TlsTestRealm.ServerKeyPem }, (req, res) => realm!.Handle(req, res));
        realm = new TlsTestRealm(server, routes);
        await new Promise<void>(resolve => server.listen(0, TlsTestRealm.Host, resolve));
        return realm;
    }

    /** The test CA as a PEM file (written once per process). */
    public static get CaFile(): string
    {
        if (TlsTestRealm.caFile === undefined)
        {
            const path = join(mkdtempSync(join(tmpdir(), TlsTestRealm.TempPrefix)), TlsTestRealm.CaFileName);
            writeFileSync(path, TlsTestRealm.CaPem);
            TlsTestRealm.caFile = path;
        }
        return TlsTestRealm.caFile;
    }

    public get Origin(): string
    {
        return "https://" + TlsTestRealm.Host + ":" + String((this.server.address() as AddressInfo).port);
    }

    public Url(path: string): string
    {
        return this.Origin + path;
    }

    public async Stop(): Promise<void>
    {
        this.server.closeAllConnections();
        await new Promise<void>(resolve => this.server.close(() => resolve()));
    }

    private Handle(req: IncomingMessage, res: ServerResponse): void
    {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () =>
        {
            const body = Buffer.concat(chunks).toString("utf8");
            const path = req.url ?? "";
            this.Requests.push(path);
            const route = this.routes.get(path);
            const reply = route !== undefined ? route(req, body) : TlsTestRealm.Echo(req, path, body);
            res.writeHead(200, { "content-type": TlsTestRealm.JsonType });
            res.end(JSON.stringify(reply));
        });
    }

    private static Echo(req: IncomingMessage, path: string, body: string): Record<string, unknown>
    {
        const echo: Record<string, unknown> = { path, method: req.method };
        if (req.headers.authorization !== undefined)
        {
            echo.authorization = req.headers.authorization;
        }
        if (body.length > 0)
        {
            echo.body = body;
        }
        return echo;
    }
}
