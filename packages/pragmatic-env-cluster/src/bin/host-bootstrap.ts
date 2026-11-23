import type { ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import type { IAuditSink } from '@pragmatic-tech-ai/pragmatic-identity'
import type { MachineTlsRef } from '../cluster/machine-tls.js'
import type { Observability, IObservabilityOptions, ObservabilityRole } from '../observability/observability.js'
import type { OtlpProtocol } from '../observability/otlp-protocol.js'
import { AuditSinkKind } from '../config/audit-sink-kind.js'
import { NullAccessAuditSink, type IAccessAuditSink } from '../host/access-audit.js'
import { FileAccessAuditSink } from '../host/file-access-audit-sink.js'
import { SqlAuditAccessSink } from '../host/sql-access-audit-sink.js'
import { TokenBucketRateLimiter, type RateLimitConfig } from '../host/rate-limiter.js'
import { RateLimitGuard } from '../host/rate-limit-guard.js'

/** The observability settings a process's configuration carries (server, worker and gateway alike). */
export interface IObservabilityConfigView
{
    serviceName?: string
    replicaId?: string
    metricsPort?: number
    otlpEndpoint?: string
    otlpProtocol?: OtlpProtocol
    otlpMetrics?: boolean
    traceSampling?: number
}

/**
 * What the environment server, its workers and the environment gateway compose the same way at start: observability,
 * the access audit sink, the rate limit, and the startup line's shared tokens. Each process's own options stay with it
 * (ServerBootstrap in the env-server, GatewayBootstrap in the gateway).
 */
export class HostBootstrap
{
    private static readonly ClientMtlsOn = 'on'
    private static readonly ClientMtlsOff = 'off'
    private static readonly ClientMtlsLabel = ' client-mtls='
    private static readonly OtelOn = 'on'
    private static readonly OtelOff = 'off'
    private static readonly OtelLabel = ' otel='
    private static readonly AuditFailuresMetric = 'audit_write_failures_total'
    private static readonly AuditFileRequired = 'audit file path required when audit sink is file'
    private static readonly SqlNeedsStore = 'audit sink sql requires an SQL audit store'
    private static readonly AuditLabel = ' audit='
    private static readonly RateLimitLabel = ' ratelimit='
    private static readonly DrainLabel = ' drain='
    private static readonly RateLimitOn = 'on'
    private static readonly RateLimitOff = 'off'

    public static OtelEnabled(config: IObservabilityConfigView): boolean
    {
        const tracing = config.otlpEndpoint !== undefined && config.otlpEndpoint.length > 0
        const metrics = config.metricsPort !== undefined || config.otlpMetrics === true
        return tracing || metrics
    }

    public static ObservabilityOptions(config: IObservabilityConfigView, role: ObservabilityRole, replicaId?: string): IObservabilityOptions | undefined
    {
        if (!HostBootstrap.OtelEnabled(config))
        {
            return undefined
        }
        return {
            role,
            serviceName: config.serviceName,
            replicaId: replicaId ?? config.replicaId,
            metricsPort: config.metricsPort,
            otlpEndpoint: config.otlpEndpoint,
            otlpProtocol: config.otlpProtocol,
            otlpMetrics: config.otlpMetrics,
            traceSampling: config.traceSampling,
        }
    }

    public static AuditSink(config: { auditSink?: AuditSinkKind; auditFile?: string }, logger: ILogger, observability?: Observability, cloudAudit?: IAuditSink): IAccessAuditSink
    {
        if (config.auditSink === AuditSinkKind.File)
        {
            if (config.auditFile === undefined || config.auditFile.length === 0)
            {
                throw new Error(HostBootstrap.AuditFileRequired)
            }
            return new FileAccessAuditSink(config.auditFile, undefined, logger, observability?.Meter().createCounter(HostBootstrap.AuditFailuresMetric))
        }
        if (config.auditSink === AuditSinkKind.Sql)
        {
            if (cloudAudit === undefined)
            {
                throw new Error(HostBootstrap.SqlNeedsStore)
            }
            return new SqlAuditAccessSink(cloudAudit, logger)
        }
        return new NullAccessAuditSink()
    }

    public static RateLimit(config: { rateLimit?: RateLimitConfig }, audit: IAccessAuditSink, observability?: Observability, logger?: ILogger): RateLimitGuard
    {
        if (config.rateLimit === undefined)
        {
            return new RateLimitGuard()
        }
        const meter = observability?.Meter()
        return new RateLimitGuard(new TokenBucketRateLimiter(config.rateLimit), audit, meter?.createCounter(RateLimitGuard.MetricName()), logger, meter?.createCounter(RateLimitGuard.ErrorMetricName()))
    }

    /** The startup line's ` drain=<ms>` token, empty without a drain timeout. */
    public static DrainToken(config: { drainTimeoutMs?: number }): string
    {
        return config.drainTimeoutMs === undefined ? '' : HostBootstrap.DrainLabel + config.drainTimeoutMs
    }

    /** The startup line's ` audit=<sink> ratelimit=<on|off>` tokens. */
    public static SecurityTokens(config: { auditSink?: AuditSinkKind; rateLimit?: RateLimitConfig }): string
    {
        const audit = config.auditSink ?? AuditSinkKind.None
        const rateLimit = config.rateLimit !== undefined ? HostBootstrap.RateLimitOn : HostBootstrap.RateLimitOff
        return HostBootstrap.AuditLabel + audit + HostBootstrap.RateLimitLabel + rateLimit
    }

    /** The startup line's ` otel=<on|off>` token. */
    public static OtelToken(config: IObservabilityConfigView): string
    {
        return HostBootstrap.OtelLabel + (HostBootstrap.OtelEnabled(config) ? HostBootstrap.OtelOn : HostBootstrap.OtelOff)
    }

    /** The startup line's ` client-mtls=<on|off>` token. */
    public static ClientMtlsToken(clientTls: MachineTlsRef | undefined): string
    {
        return HostBootstrap.ClientMtlsLabel + (clientTls !== undefined ? HostBootstrap.ClientMtlsOn : HostBootstrap.ClientMtlsOff)
    }
}
