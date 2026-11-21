/** Time for an install or a rollout wait: injectable so tests run the wait in virtual time. */
export interface IInstallClock
{
    Now(): number
    Delay(ms: number): Promise<void>
}

/** The real clock: wall time and a timer that does not keep the process alive. */
export class SystemInstallClock implements IInstallClock
{
    public Now(): number
    {
        return Date.now()
    }

    public Delay(ms: number): Promise<void>
    {
        return new Promise(resolve => setTimeout(resolve, ms).unref())
    }
}
