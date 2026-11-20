import type { IAgentChannel } from '../channel/agent-channel.js'
import { SignedEnvelope } from '../envelope/signed-envelope.js'
import type { FakePlatform } from './fake-platform.js'

/** One message as it crossed the fake wire. */
export class FakeWireEntry
{
    public constructor(public readonly Direction: FakeWireDirection, public readonly Text: string)
    {
    }
}

export enum FakeWireDirection
{
    ToPlatform = 'to-platform',
    ToAgent = 'to-agent',
}

/**
 * An agent channel wired to a FakePlatform in memory. Every message crosses as its wire text and is decoded again on
 * the other side (so the strict codecs run both ways), and the text is logged in `Wire`. Tests can rewrite the next
 * outgoing text (`TamperNext`) or send a logged text again (`Resend`) to prove replay and tampering are refused.
 */
export class FakeAgentChannel implements IAgentChannel
{
    public readonly Wire: FakeWireEntry[] = []
    private tamper: ((text: string) => string) | undefined

    public constructor(public readonly Platform: FakePlatform)
    {
    }

    public TamperNext(change: (text: string) => string): void
    {
        this.tamper = change
    }

    public async Exchange(request: SignedEnvelope): Promise<SignedEnvelope | null>
    {
        const change = this.tamper
        this.tamper = undefined
        const text = change === undefined ? request.Encode() : change(request.Encode())
        return this.Send(text)
    }

    /** Sends a wire text as it is (a captured message replayed). */
    public async Resend(text: string): Promise<SignedEnvelope | null>
    {
        return this.Send(text)
    }

    /** The texts sent to the platform, oldest first. */
    public get Sent(): string[]
    {
        return this.Wire.filter(entry => entry.Direction === FakeWireDirection.ToPlatform).map(entry => entry.Text)
    }

    private async Send(text: string): Promise<SignedEnvelope | null>
    {
        this.Wire.push(new FakeWireEntry(FakeWireDirection.ToPlatform, text))
        const reply = await this.Platform.Handle(SignedEnvelope.Decode(text))
        if (reply === null)
        {
            return null
        }
        const replyText = reply.Encode()
        this.Wire.push(new FakeWireEntry(FakeWireDirection.ToAgent, replyText))
        return SignedEnvelope.Decode(replyText)
    }
}
