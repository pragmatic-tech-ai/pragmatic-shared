import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ProtocolDecodeError } from '../../wire/protocol-decode-error.js'
import {
    ComponentReport, ComponentState, EnvironmentReadiness, EnvironmentStatus, HiveReport, IntentFailure, IntentProgress, IntentStatus,
} from '../hive-report.js'

class Samples
{
    public static Json(): Record<string, unknown>
    {
        return HiveReport.Create({
            EngineVersion: '0.10.0',
            Components: [new ComponentReport('hive-agent', ComponentState.Ready, '0.10.0'), new ComponentReport('pragmatic-postgres', ComponentState.Installing, null)],
            Environments: [new EnvironmentStatus('prod', EnvironmentReadiness.Ready, '1.3.0'), new EnvironmentStatus('staging', EnvironmentReadiness.Progressing, null)],
            Intents: [IntentStatus.Of('intent-4', IntentProgress.AwaitingApproval)],
        }).ToJson() as unknown as Record<string, unknown>
    }
}

describe('HiveReport', () =>
{
    it('carries component states, environment name/readiness/version and intent progress', () =>
    {
        const json = Samples.Json()
        const report = HiveReport.Parse(JSON.parse(JSON.stringify(json)))
        assert.deepEqual(report.ToJson(), json)
        assert.equal(report.Environments[0]?.Readiness, EnvironmentReadiness.Ready)
    })

    it('cannot carry logs, error text or environment data: no free-text member exists', () =>
    {
        const json = Samples.Json() as { Components: Record<string, unknown>[], Environments: Record<string, unknown>[], Intents: Record<string, unknown>[] }
        const leaks: Record<string, unknown>[] = [
            { ...json, Logs: ['line 1'] },
            { ...json, Error: 'connection refused' },
            { ...json, Components: [{ ...json.Components[0], Message: 'CrashLoopBackOff: ...' }] },
            { ...json, Components: [{ ...json.Components[0], State: 'failed: out of memory' }] },
            { ...json, Components: [{ ...json.Components[0], Version: '0.10.0 (see /var/log/agent.log)' }] },
            { ...json, Environments: [{ ...json.Environments[0], Name: 'customers table has 10421 rows' }] },
            { ...json, Environments: [{ ...json.Environments[0], Data: { rows: 1 } }] },
            { ...json, Environments: [{ ...json.Environments[0], Readiness: 'ready: 3/3 pods' }] },
            { ...json, Intents: [{ ...json.Intents[0], Progress: 'failed', Reason: 'quota exceeded' }] },
            { ...json, EngineVersion: 'a'.repeat(65) },
        ]
        for (const leak of leaks)
        {
            assert.throws(() => HiveReport.Parse(leak), ProtocolDecodeError)
        }
    })

    it('bounds every list and refuses duplicates', () =>
    {
        const json = Samples.Json() as { Environments: Record<string, unknown>[] }
        const many = Array.from({ length: HiveReport.MaxEnvironments + 1 }, (_, index) => ({ Name: 'env-' + index, Readiness: 'ready', Version: null }))
        assert.throws(() => HiveReport.Parse({ ...json, Environments: many }), ProtocolDecodeError)
        assert.throws(() => HiveReport.Parse({ ...json, Environments: [json.Environments[0], json.Environments[0]] }), ProtocolDecodeError)
        assert.equal(HiveReport.Parse({ ...json, Environments: many.slice(1) }).Environments.length, HiveReport.MaxEnvironments)
    })
})

describe('IntentStatus', () =>
{
    it('carries a failure code exactly when the intent failed, and never text', () =>
    {
        const failed = IntentStatus.FailedWith('in0000000000ab', IntentFailure.NotReady)
        assert.deepEqual(IntentStatus.Parse(failed.ToJson(), 'status').ToJson(), { IntentId: 'in0000000000ab', Progress: IntentProgress.Failed, Failure: IntentFailure.NotReady })
        assert.equal(IntentStatus.Of('in0000000000ab', IntentProgress.Applied).Failure, null)
        assert.throws(() => IntentStatus.Parse({ IntentId: 'in0000000000ab', Progress: IntentProgress.Failed, Failure: null }, 'status'), ProtocolDecodeError)
        assert.throws(() => IntentStatus.Parse({ IntentId: 'in0000000000ab', Progress: IntentProgress.Applied, Failure: IntentFailure.ApplyFailed }, 'status'), ProtocolDecodeError)
        assert.throws(() => IntentStatus.Parse({ IntentId: 'in0000000000ab', Progress: IntentProgress.Failed, Failure: 'ImagePullBackOff: denied' }, 'status'), ProtocolDecodeError)
    })
})
