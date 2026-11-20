import type { JsonValue } from '@pragmatic-tech-ai/pragmatic-component';

/** A configuration document as JSON: copied in and out so a caller never shares a held document. */
export class JsonDocument
{
    public static Copy(document: Record<string, JsonValue>): Record<string, JsonValue>
    {
        return structuredClone(document);
    }

    public static IsObject(value: unknown): value is Record<string, JsonValue>
    {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }
}
