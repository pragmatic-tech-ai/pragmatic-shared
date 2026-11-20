import type { IncomingMessage } from 'node:http'
import type { SessionRecord } from '../session/session-record.js'

/** What a socket handler gets once the upgrade passed the pipeline: the upgrade request, the route's params, the
 *  session the ticket named (null on a public socket) and the client address. */
export class SocketContext
{
    public constructor(
        public readonly Request: IncomingMessage,
        public readonly Params: ReadonlyMap<string, string>,
        public readonly Session: SessionRecord | null,
        public readonly ClientAddress: string)
    {
    }
}
