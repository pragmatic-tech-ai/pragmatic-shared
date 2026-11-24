import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SigningKeyPair } from '../../crypto/signing-key.js'
import { EnvelopeSigner } from '../../envelope/envelope-signer.js'
import { MessageKind } from '../../envelope/message-kind.js'
import { Participant, ParticipantRole } from '../../envelope/participant.js'
import { SignedEnvelope } from '../../envelope/signed-envelope.js'
import { PullBatch } from '../../intent/pull.js'
import { ComponentReport, ComponentState, HiveReport } from '../../report/hive-report.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { AgentExchangeLink, AgentExchangeRefusal } from '../agent-exchange-link.js'
import { AgentChannelFailure, AgentChannelUnavailableError, HttpAgentChannel } from '../http-agent-channel.js'

/** A local HTTP server standing in for the edge: records what it got, answers what the test sets. */
class EdgeStub
{
    public Received: { Method: string, Url: string, ContentType: string | undefined, Body: string }[] = []
    public Answer: (res: ServerResponse) => void = res => res.writeHead(204).end()
    private server: Server | undefined

    public async Start(): Promise<string>
    {
        this.server = createServer((req: IncomingMessage, res: ServerResponse) =>
        {
            const chunks: Buffer[] = []
            req.on('data', (chunk: Buffer) => chunks.push(chunk))
            req.on('end', () =>
            {
                this.Received.push({ Method: req.method ?? '', Url: req.url ?? '', ContentType: req.headers['content-type'], Body: Buffer.concat(chunks).toString('utf8') })
                this.Answer(res)
            })
        })
        await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve))
        return 'http://127.0.0.1:' + (this.server!.address() as AddressInfo).port + '/'
    }

    public Stop(): Promise<void>
    {
        this.server!.closeAllConnections()
        return new Promise(resolve => this.server!.close(() => resolve()))
    }
}

class ChannelFixture
{
    public static readonly Clock = new FakeClock()
    public static readonly Hive = SigningKeyPair.Generate()
    public static readonly Platform = SigningKeyPair.Generate()

    public static Report(): SignedEnvelope
    {
        const report = HiveReport.Create({ EngineVersion: '0.1.7', Components: [new ComponentReport('pragmatic-hive-agent', ComponentState.Ready, '0.1.7')], Environments: [], Intents: [] })
        return new EnvelopeSigner(ChannelFixture.Hive, Participant.Hive('hvabcdefghij'), ChannelFixture.Clock).Sign(MessageKind.HiveReport, Participant.Platform, report)
    }

    public static PlatformAnswer(): SignedEnvelope
    {
        return new EnvelopeSigner(ChannelFixture.Platform, Participant.Platform, ChannelFixture.Clock).Sign(MessageKind.PullBatch, Participant.Of(ParticipantRole.Hive, 'hvabcdefghij'), PullBatch.Create([], 0))
    }
}

describe('AgentExchangeLink', () =>
{
    it('the public and internal exchange paths and the body limit are the documented values', () =>
    {
        assert.equal(AgentExchangeLink.PublicPath, '/agent/v2/exchange')
        assert.equal(AgentExchangeLink.BodyLimit, 1_048_576)
        assert.equal(AgentExchangeLink.BodyLimit, SignedEnvelope.MaxBytes)
        assert.equal(AgentExchangeLink.ContentType, 'application/json')
    })

    it('every refusal has a status and its body names only the code', () =>
    {
        for (const code of AgentExchangeLink.Codes)
        {
            const status = AgentExchangeLink.StatusOf(code)
            assert.ok(status >= 400 && status < 600, code)
            assert.deepEqual(Object.keys(AgentExchangeLink.RefusalBody(code)).sort(), ['code', 'error'])
            assert.equal(AgentExchangeLink.CodeOf(AgentExchangeLink.RefusalBody(code)), code)
        }
        assert.equal(AgentExchangeLink.CodeOf({ code: 'something-else' }), null)
        assert.equal(AgentExchangeLink.CodeOf(null), null)
        assert.equal(AgentExchangeLink.CodeOf([]), null)
    })
})

describe('HttpAgentChannel', () =>
{
    const edge = new EdgeStub()
    let base = ''

    before(async () =>
    {
        base = await edge.Start()
    })
    after(() => edge.Stop())

    it('the exchange URL has one separator whatever the channel URL ends with', () =>
    {
        assert.equal(HttpAgentChannel.ExchangeUrl('https://agent.pragmatic-tech.ai'), 'https://agent.pragmatic-tech.ai/agent/v2/exchange')
        assert.equal(HttpAgentChannel.ExchangeUrl('https://agent.pragmatic-tech.ai/'), 'https://agent.pragmatic-tech.ai/agent/v2/exchange')
    })

    it('HttpAgentChannel posts the wire text and decodes the answer', async () =>
    {
        const answer = ChannelFixture.PlatformAnswer()
        edge.Answer = res => res.writeHead(200, { 'content-type': 'application/json' }).end(answer.Encode())
        const request = ChannelFixture.Report()
        const reply = await new HttpAgentChannel(base).Exchange(request)
        const got = edge.Received.at(-1)!
        assert.equal(got.Method, 'POST')
        assert.equal(got.Url, '/agent/v2/exchange')
        assert.equal(got.ContentType, 'application/json')
        assert.equal(got.Body, request.Encode())
        assert.ok(reply !== null)
        assert.equal(reply.Encode(), answer.Encode())
    })

    it('204 is null', async () =>
    {
        edge.Answer = res => res.writeHead(204).end()
        assert.equal(await new HttpAgentChannel(base).Exchange(ChannelFixture.Report()), null)
    })

    it('a 503 raises AgentChannelUnavailableError', async () =>
    {
        edge.Answer = res => res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify(AgentExchangeLink.RefusalBody(AgentExchangeRefusal.Unavailable)))
        await assert.rejects(new HttpAgentChannel(base).Exchange(ChannelFixture.Report()), (error: unknown) =>
            error instanceof AgentChannelUnavailableError && error.Status === 503 && error.Code === AgentExchangeRefusal.Unavailable && error.Failure === AgentChannelFailure.Refused)
    })

    it('a refusal carries its code and no text from the answer', async () =>
    {
        edge.Answer = res => res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'SECRET-TEXT', code: 'mismatch' }))
        await assert.rejects(new HttpAgentChannel(base).Exchange(ChannelFixture.Report()), (error: unknown) =>
            error instanceof AgentChannelUnavailableError && error.Code === AgentExchangeRefusal.Mismatch && !error.message.includes('SECRET-TEXT'))
    })

    it('an answer over 1 MiB is refused unread', async () =>
    {
        const big = 'x'.repeat(AgentExchangeLink.BodyLimit + 1)
        edge.Answer = res => res.writeHead(200, { 'content-type': 'application/json' }).end(big)
        await assert.rejects(new HttpAgentChannel(base).Exchange(ChannelFixture.Report()), (error: unknown) =>
            error instanceof AgentChannelUnavailableError && error.Failure === AgentChannelFailure.BadAnswer)
        edge.Answer = res =>
        {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.write(big.slice(0, 600_000))
            res.end(big.slice(600_000))
        }
        await assert.rejects(new HttpAgentChannel(base).Exchange(ChannelFixture.Report()), (error: unknown) =>
            error instanceof AgentChannelUnavailableError && error.Failure === AgentChannelFailure.BadAnswer)
    })

    it('a 200 that is not an envelope is a bad answer', async () =>
    {
        edge.Answer = res => res.writeHead(200, { 'content-type': 'application/json' }).end('{"not":"an envelope"}')
        await assert.rejects(new HttpAgentChannel(base).Exchange(ChannelFixture.Report()), (error: unknown) =>
            error instanceof AgentChannelUnavailableError && error.Failure === AgentChannelFailure.BadAnswer && error.Status === 200)
    })

    it('an unreachable platform or a missed deadline is Unreachable with no status', async () =>
    {
        await assert.rejects(new HttpAgentChannel('http://127.0.0.1:1').Exchange(ChannelFixture.Report()), (error: unknown) =>
            error instanceof AgentChannelUnavailableError && error.Failure === AgentChannelFailure.Unreachable && error.Status === null)
        edge.Answer = () => undefined
        await assert.rejects(new HttpAgentChannel(base, 200).Exchange(ChannelFixture.Report()), (error: unknown) =>
            error instanceof AgentChannelUnavailableError && error.Failure === AgentChannelFailure.Unreachable)
    })
})
