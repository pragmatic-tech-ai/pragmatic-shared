import type { IncomingMessage, ServerResponse } from 'node:http'
import { JsonApi } from '../http/json-api.js'
import { HttpProblem } from '../http/http-problem.js'
import type { SessionRecord } from '../session/session-record.js'

/** What a route handler gets: the request and response, the route's params, the query, the authenticated session
 *  (null on a public route without one), the client address, and the JSON helpers bound to the route's body limit. */
export class RequestContext
{
    private static readonly StatusUnauthorized = 401
    private static readonly UnauthenticatedMessage = 'Not signed in'
    private static readonly MissingParamMessage = 'Missing route parameter: '

    private auditNote: string | undefined

    public constructor(
        public readonly Request: IncomingMessage,
        public readonly Response: ServerResponse,
        public readonly Path: string,
        public readonly Params: ReadonlyMap<string, string>,
        public readonly Query: URLSearchParams,
        public readonly Session: SessionRecord | null,
        public readonly ClientAddress: string,
        public readonly BodyLimit: number)
    {
    }

    /** The note the audit entry of this request carries (what the operation kept or skipped; never secrets). */
    public get AuditNote(): string | undefined
    {
        return this.auditNote
    }

    public NoteAudit(note: string): void
    {
        this.auditNote = note
    }

    /** A declared route parameter (the pattern guarantees it is present and non-empty). */
    public Param(name: string): string
    {
        const value = this.Params.get(name)
        if (value === undefined)
        {
            throw new Error(RequestContext.MissingParamMessage + name)
        }
        return value
    }

    /** The session, for handlers of Session routes; a 401 problem when there is none. */
    public RequireSession(): SessionRecord
    {
        if (this.Session === null)
        {
            throw new HttpProblem(RequestContext.StatusUnauthorized, RequestContext.UnauthenticatedMessage)
        }
        return this.Session
    }

    public ReadJson(): Promise<unknown>
    {
        return JsonApi.ReadJson(this.Request, this.BodyLimit)
    }

    public ReadJsonObject(): Promise<Record<string, unknown>>
    {
        return JsonApi.ReadJsonObject(this.Request, this.BodyLimit)
    }

    public WriteJson(status: number, body: unknown): void
    {
        JsonApi.WriteJson(this.Response, status, body)
    }
}
