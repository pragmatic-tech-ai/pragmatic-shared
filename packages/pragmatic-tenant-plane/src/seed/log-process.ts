/** A long-lived child process whose combined stdout+stderr is streamed as utf8 text. */
export interface ILogProcess
{
    OnData(cb: (chunk: string) => void): void
    OnClose(cb: () => void): void
    Kill(): void
}
