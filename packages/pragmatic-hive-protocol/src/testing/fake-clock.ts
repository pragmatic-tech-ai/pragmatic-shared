import type { IProtocolClock } from '../envelope/protocol-clock.js'

/** A clock tests move by hand; starts at 2026-11-20T10:00:00Z. */
export class FakeClock implements IProtocolClock
{
    public static readonly Start = '2026-11-20T10:00:00.000Z'
    private time: number

    public constructor(start: string = FakeClock.Start)
    {
        this.time = Date.parse(start)
    }

    public Now(): Date
    {
        return new Date(this.time)
    }

    public Advance(ms: number): void
    {
        this.time += ms
    }
}
