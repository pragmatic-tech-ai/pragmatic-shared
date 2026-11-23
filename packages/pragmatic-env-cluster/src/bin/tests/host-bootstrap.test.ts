import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuditEvent, IAuditSink } from '@pragmatic-tech-ai/pragmatic-identity'
import { NullLogger } from '@pragmatic-tech-ai/pragmatic-observability'
import { DeploymentMode } from '../../platform/deployment-mode.js'
import { AuditSinkKind } from '../../config/audit-sink-kind.js'
import type { ServerConfig } from '../../config/server-config.js'
import { NullAccessAuditSink, AuditSurface, AuditOutcome } from '../../host/access-audit.js'
import { FileAccessAuditSink } from '../../host/file-access-audit-sink.js'
import { SqlAuditAccessSink } from '../../host/sql-access-audit-sink.js'
import { RateLimitScope } from '../../host/rate-limiter.js'
import { Observability, ObservabilityRole } from '../../observability/observability.js'
import { OtlpProtocol } from '../../observability/otlp-protocol.js'
import { HostBootstrap } from '../host-bootstrap.js'

class CapturingStore implements IAuditSink
{
    public readonly Events: AuditEvent[] = []

    public Record(event: AuditEvent): Promise<void>
    {
        this.Events.push(event)
        return Promise.resolve()
    }
}

class SecurityFixture
{
    public static BaseConfig(): ServerConfig
    {
        return { host: '0.0.0.0', port: 8080, baseDir: '/d', masterKey: { keyFilePath: '/k' }, deploymentMode: DeploymentMode.Local }
    }

    public static Environment(): { scope: RateLimitScope; environment: string; key: string }
    {
        return { scope: RateLimitScope.Environment, environment: 't1', key: 't1' }
    }

    public static Context(): { surface: AuditSurface; environment: string; methodOrPath: string }
    {
        return { surface: AuditSurface.Upgrade, environment: 't1', methodOrPath: 'ws' }
    }
}

class Fixtures
{
    private static readonly LoopbackHost = '127.0.0.1'

    public static Config(extra: Partial<ServerConfig> = {}): ServerConfig
    {
        return { host: '0.0.0.0', port: 8443, baseDir: '/data', masterKey: { keyFilePath: '/run/secrets/key' }, deploymentMode: DeploymentMode.Local, replicaId: 'pod-1', tls: { certFile: '/c.pem', keyFile: '/k.pem', caFile: '/ca.pem' }, ...extra }
    }

    public static async FreePort(): Promise<number>
    {
        return new Promise<number>((resolve, reject) =>
        {
            const server = createServer()
            server.once('error', reject)
            server.listen(0, Fixtures.LoopbackHost, () =>
            {
                const port = (server.address() as { port: number }).port
                server.close(() => resolve(port))
            })
        })
    }
}

test('AuditSink returns a NullAccessAuditSink when unconfigured', () =>
{
    assert.ok(HostBootstrap.AuditSink(SecurityFixture.BaseConfig(), new NullLogger()) instanceof NullAccessAuditSink)
})

test('AuditSink=file builds a FileAccessAuditSink that writes to the path', async () =>
{
    const dir = mkdtempSync(join(tmpdir(), 'ps-bs-'))
    const path = join(dir, 'a.log')
    try
    {
        const sink = HostBootstrap.AuditSink({ ...SecurityFixture.BaseConfig(), auditSink: AuditSinkKind.File, auditFile: path }, new NullLogger())
        assert.ok(sink instanceof FileAccessAuditSink)
        await sink.Record({ Timestamp: new Date(), EnvironmentId: 't1', Surface: AuditSurface.Rpc, MethodOrPath: 'm', Outcome: AuditOutcome.Allow })
        assert.ok(readFileSync(path, 'utf8').includes('"environment":"t1"'))
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('AuditSink=sql with a cloud store builds a SqlAuditAccessSink; without one it fails closed', async () =>
{
    const store = new CapturingStore()
    const config = { ...SecurityFixture.BaseConfig(), auditSink: AuditSinkKind.Sql }
    const sink = HostBootstrap.AuditSink(config, new NullLogger(), undefined, store)
    assert.ok(sink instanceof SqlAuditAccessSink)
    await sink.Record({ Timestamp: new Date(), EnvironmentId: 't1', Surface: AuditSurface.Rpc, MethodOrPath: 'm', Outcome: AuditOutcome.Allow })
    assert.equal(store.Events.length, 1)
    assert.throws(() => HostBootstrap.AuditSink(config, new NullLogger()), /SQL audit store/)
})

test('RateLimit returns a pass-through guard when unconfigured and an enforcing guard when configured', () =>
{
    const disabled = HostBootstrap.RateLimit(SecurityFixture.BaseConfig(), new NullAccessAuditSink())
    for (let i = 0; i < 20; i++)
    {
        assert.equal(disabled.Check(SecurityFixture.Environment(), SecurityFixture.Context()).Allowed, true)
    }
    const enforcing = HostBootstrap.RateLimit({ ...SecurityFixture.BaseConfig(), rateLimit: { perEnvironment: { Rps: 0.001, Burst: 1 } } }, new NullAccessAuditSink())
    assert.equal(enforcing.Check(SecurityFixture.Environment(), SecurityFixture.Context()).Allowed, true)
    assert.equal(enforcing.Check(SecurityFixture.Environment(), SecurityFixture.Context()).Allowed, false)
})

test('AuditSink=file without a path fails closed instead of returning a null sink', () =>
{
    assert.throws(() => HostBootstrap.AuditSink({ ...SecurityFixture.BaseConfig(), auditSink: AuditSinkKind.File }, new NullLogger()), /audit file path required/)
    assert.throws(() => HostBootstrap.AuditSink({ ...SecurityFixture.BaseConfig(), auditSink: AuditSinkKind.File, auditFile: '' }, new NullLogger()), /audit file path required/)
})

test('ObservabilityOptions is undefined when otel is off', () =>
{
    assert.equal(HostBootstrap.ObservabilityOptions(Fixtures.Config(), ObservabilityRole.Host), undefined)
})

test('ObservabilityOptions maps fields and role when enabled', () =>
{
    const config = Fixtures.Config({ serviceName: 'svc', metricsPort: 9100, otlpEndpoint: 'http://collector:4318', otlpProtocol: OtlpProtocol.HttpProtobuf, otlpMetrics: true, traceSampling: 0.5 })
    const o = HostBootstrap.ObservabilityOptions(config, ObservabilityRole.Worker)
    assert.deepEqual(o, { role: ObservabilityRole.Worker, serviceName: 'svc', replicaId: 'pod-1', metricsPort: 9100, otlpEndpoint: 'http://collector:4318', otlpProtocol: OtlpProtocol.HttpProtobuf, otlpMetrics: true, traceSampling: 0.5 })
})

test('ObservabilityOptions replicaId argument overrides config', () =>
{
    const o = HostBootstrap.ObservabilityOptions(Fixtures.Config({ metricsPort: 9100 }), ObservabilityRole.Host, 'other')
    assert.equal(o?.replicaId, 'other')
})

test('Observability started from mapped options shuts down cleanly', async () =>
{
    const port = await Fixtures.FreePort()
    const opts = HostBootstrap.ObservabilityOptions(Fixtures.Config({ metricsPort: port }), ObservabilityRole.Host)
    assert.ok(opts)
    await Observability.Start(opts).Shutdown()
})
