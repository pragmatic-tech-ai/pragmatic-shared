import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ConsoleAddress } from '../../hive/console-address.js'
import { HiveLevel } from '../../hive/hive-level.js'
import { ProtocolDecodeError } from '../../wire/protocol-decode-error.js'
import { AgentInternalLink, HiveEnrolmentCall, HiveEnrolmentRefusal, HiveEnrolmentStatus } from '../agent-internal-link.js'

class CallFixture
{
    public static readonly Code = 'pe1-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    public static readonly Address = ConsoleAddress.OwnDomain('console.acme.example')
}

describe('AgentInternalLink', () =>
{
    it('is the documented port, service, audience and paths', () =>
    {
        assert.equal(AgentInternalLink.Port, 7210)
        assert.equal(AgentInternalLink.ServiceName, 'pragmatic-hive-agent-internal')
        assert.equal(AgentInternalLink.Audience, 'pragmatic-hive-agent')
        assert.equal(AgentInternalLink.EnrolPath, '/internal/enrol')
        assert.equal(AgentInternalLink.EnrolmentPath, '/internal/enrolment')
    })

    it('every refusal has a status and round-trips its code', () =>
    {
        for (const code of AgentInternalLink.Codes)
        {
            assert.ok(AgentInternalLink.StatusOf(code) >= 400, code)
            assert.equal(AgentInternalLink.CodeOf(AgentInternalLink.RefusalBody(code)), code)
        }
        assert.equal(AgentInternalLink.CodeOf({ code: 'other' }), null)
        assert.equal(AgentInternalLink.StatusOf(HiveEnrolmentRefusal.NotConsole), 403)
    })
})

describe('HiveEnrolmentCall', () =>
{
    it('round-trips Enrolled and Delegated with the console address', () =>
    {
        for (const level of [HiveLevel.Enrolled, HiveLevel.Delegated])
        {
            const call = HiveEnrolmentCall.Parse(HiveEnrolmentCall.Create(CallFixture.Code, level, CallFixture.Address).ToJson())
            assert.equal(call.Level, level)
            assert.equal(call.Code, CallFixture.Code)
            assert.equal(call.ConsoleAddress.HostName, 'console.acme.example')
        }
    })

    it('refuses Standalone, Hosted, an extra member and a bad code', () =>
    {
        const json = HiveEnrolmentCall.Create(CallFixture.Code, HiveLevel.Enrolled, CallFixture.Address).ToJson()
        for (const level of [HiveLevel.Standalone, HiveLevel.Hosted])
        {
            assert.throws(() => HiveEnrolmentCall.Parse({ ...json, Level: level }), ProtocolDecodeError)
        }
        assert.throws(() => HiveEnrolmentCall.Parse({ ...json, Extra: 1 }), ProtocolDecodeError)
        assert.throws(() => HiveEnrolmentCall.Parse({ ...json, Code: 'no spaces allowed' }), ProtocolDecodeError)
    })
})

describe('HiveEnrolmentStatus', () =>
{
    it('not enrolled has no hive, tenant or level; enrolled has all three', () =>
    {
        assert.deepEqual(HiveEnrolmentStatus.Parse(HiveEnrolmentStatus.NotEnrolled.ToJson()).ToJson(), { Enrolled: false, HiveId: null, Tenant: null, Level: null })
        const status = HiveEnrolmentStatus.Parse(HiveEnrolmentStatus.Of('hvabcdefghij', 'acme', HiveLevel.Delegated).ToJson())
        assert.equal(status.Enrolled, true)
        assert.equal(status.HiveId, 'hvabcdefghij')
        assert.equal(status.Level, HiveLevel.Delegated)
        assert.throws(() => HiveEnrolmentStatus.Parse({ Enrolled: false, HiveId: 'hvabcdefghij', Tenant: null, Level: null }), ProtocolDecodeError)
    })
})
