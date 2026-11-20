import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppHost } from '../../host/app-host.js'
import type { AppHostModules } from '../../host/app-host.js'
import { AppHostConfig } from '../../host/app-host-config.js'
import type { AppHostConfigOptions } from '../../host/app-host-config.js'
import { RouteTable } from '../../routing/route-table.js'
import { SessionStore } from '../../session/session-store.js'
import { InMemorySessionRepository } from '../../session/session-repository.js'
import { SessionPolicy } from '../../session/session-policy.js'
import { SessionCookie } from '../../session/session-cookie.js'
import { SessionGate } from '../../session/session-gate.js'
import { SessionClaims } from '../../session/session-claims.js'
import { AuditTrail } from '../../audit/audit-trail.js'
import { InMemoryAuditRepository } from '../../audit/audit-repository.js'
import { MuralBundle } from '../../bundle/mural-bundle.js'
import { TestHttp } from './test-http.js'
import type { TestRequestOptions, TestResponse } from './test-http.js'

/** A running AppHost on a loopback port with in-memory sessions and audit, and helpers to call it as a browser would. */
export class HostFixture
{
    public static readonly CookieName = 'app_session'

    public readonly Sessions = new SessionStore(new InMemorySessionRepository(), new SessionPolicy(3_600_000))
    public readonly Cookie = new SessionCookie({ Name: HostFixture.CookieName, Secure: false })
    public readonly Gate = new SessionGate(this.Sessions, this.Cookie)
    public readonly AuditRepository = new InMemoryAuditRepository()
    public readonly Audit = new AuditTrail(this.AuditRepository, { Log: () => undefined })
    public readonly Routes = new RouteTable()
    public Host: AppHost | undefined
    private bundleRoot: string | undefined

    public get Port(): number
    {
        return (this.Host as AppHost).Address().port
    }

    public get Origin(): string
    {
        return 'http://localhost:' + this.Port
    }

    public async Start(config: AppHostConfigOptions = {}, modules: Partial<AppHostModules> = {}, withBundle = false): Promise<this>
    {
        let bundle: MuralBundle | undefined
        if (withBundle)
        {
            this.bundleRoot = await mkdtemp(join(tmpdir(), 'app-host-bundle-'))
            await writeFile(join(this.bundleRoot, 'index.html'), '<!doctype html><title>Console</title>')
            await writeFile(join(this.bundleRoot, 'app-ABCDEFGH.js'), 'x')
            bundle = MuralBundle.Load(this.bundleRoot)
        }
        this.Host = new AppHost(new AppHostConfig(config), { Routes: this.Routes, Sessions: this.Gate, Audit: this.Audit, Bundle: bundle, ...modules })
        await this.Host.Listen(0, '127.0.0.1')
        return this
    }

    public async SignIn(subject: string, roles: readonly string[], extra: Record<string, string> = {}): Promise<string>
    {
        const issued = await this.Sessions.Issue(subject, SessionClaims.From({ ...extra, roles }))
        return HostFixture.CookieName + '=' + issued.Token
    }

    /** A same-origin browser call: Host is localhost:<port>; mutations carry the own Origin unless told otherwise. */
    public Send(path: string, options: TestRequestOptions & { Cookie?: string, Origin?: string | null, Json?: unknown } = {}): Promise<TestResponse>
    {
        const headers: Record<string, string | string[]> = { host: 'localhost:' + this.Port, ...(options.Headers ?? {}) }
        if (options.Cookie !== undefined)
        {
            headers.cookie = options.Cookie
        }
        if (options.Origin !== null && options.Method !== undefined && options.Method !== 'GET')
        {
            headers.origin = options.Origin ?? this.Origin
        }
        let body = options.Body
        if (options.Json !== undefined)
        {
            body = JSON.stringify(options.Json)
            headers['content-type'] = 'application/json'
            headers['content-length'] = String(Buffer.byteLength(body))
        }
        return TestHttp.Send(this.Port, path, { Method: options.Method, Headers: headers, Body: body })
    }

    public async Stop(): Promise<void>
    {
        await this.Host?.Close()
        if (this.bundleRoot !== undefined)
        {
            await rm(this.bundleRoot, { recursive: true, force: true })
        }
    }
}
