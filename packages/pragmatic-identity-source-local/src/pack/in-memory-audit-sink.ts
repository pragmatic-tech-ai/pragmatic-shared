import type { IAuditSink, AuditEvent } from "@pragmatic-tech-ai/pragmatic-identity";

export class InMemoryAuditSink implements IAuditSink
{
    public readonly Events: AuditEvent[] = [];

    public async Record(event: AuditEvent): Promise<void>
    {
        this.Events.push(event);
    }
}
