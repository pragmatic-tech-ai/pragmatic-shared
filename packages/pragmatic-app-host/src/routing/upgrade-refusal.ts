import { STATUS_CODES } from 'node:http'
import type { Duplex } from 'node:stream'

/**
 * A socket route's own answer to an upgrade it does not admit (SocketRouteDefinition.Admit): a plain HTTP status and
 * JSON body written on the raw socket before any handshake, so a client reads the refusal status (e.g. 401, 503)
 * instead of a dropped connection. The connection closes after it.
 */
export class UpgradeRefusal
{
    private static readonly StatusLinePrefix = 'HTTP/1.1 '
    private static readonly Space = ' '
    private static readonly LineEnd = '\r\n'
    private static readonly ContentType = 'Content-Type: application/json; charset=utf-8'
    private static readonly ContentLength = 'Content-Length: '
    private static readonly CacheControl = 'Cache-Control: no-store'
    private static readonly Connection = 'Connection: close'
    private static readonly Utf8 = 'utf8'
    private static readonly MinStatus = 400
    private static readonly MaxStatus = 599
    private static readonly BadStatusMessage = 'UpgradeRefusal: the status must be a 4xx or 5xx code: '

    public constructor(public readonly Status: number, public readonly Body: object)
    {
        if (!Number.isInteger(Status) || Status < UpgradeRefusal.MinStatus || Status > UpgradeRefusal.MaxStatus)
        {
            throw new Error(UpgradeRefusal.BadStatusMessage + Status)
        }
    }

    /** Writes the refusal and ends the socket. */
    public WriteTo(socket: Duplex): void
    {
        const R = UpgradeRefusal
        const body = Buffer.from(JSON.stringify(this.Body), R.Utf8)
        const head = R.StatusLinePrefix + this.Status + R.Space + (STATUS_CODES[this.Status] ?? '') + R.LineEnd
            + R.ContentType + R.LineEnd
            + R.ContentLength + body.length + R.LineEnd
            + R.CacheControl + R.LineEnd
            + R.Connection + R.LineEnd + R.LineEnd
        socket.end(Buffer.concat([Buffer.from(head, R.Utf8), body]))
    }
}
