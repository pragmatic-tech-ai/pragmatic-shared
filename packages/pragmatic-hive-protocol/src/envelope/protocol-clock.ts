/** The time the protocol checks freshness against (a fake one in tests). */
export interface IProtocolClock
{
    Now(): Date
}

export class SystemProtocolClock implements IProtocolClock
{
    public Now(): Date
    {
        return new Date()
    }
}
