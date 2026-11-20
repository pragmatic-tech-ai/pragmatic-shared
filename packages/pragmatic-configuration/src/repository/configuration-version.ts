import type { JsonValue } from '@pragmatic-tech-ai/pragmatic-component';
import { ConfigurationScope } from './configuration-scope.js';
import { JsonDocument } from './json-document.js';

/**
 * One saved configuration version of a scope: its number (1, 2, ... in save order), the document as authored (A6 shape,
 * secret settings as secret references), the component version and descriptor digest it was validated against, who
 * saved it (a realm subject), when, and why. Immutable; `Document` is a fresh copy on every read.
 */
export class ConfigurationVersion
{
    private readonly document: Record<string, JsonValue>;

    public constructor(
        public readonly Scope: ConfigurationScope,
        public readonly Number: number,
        document: Record<string, JsonValue>,
        public readonly ComponentVersion: string,
        public readonly DescriptorDigest: string,
        public readonly Author: string,
        public readonly CreatedAt: Date,
        public readonly Comment: string,
    )
    {
        this.document = JsonDocument.Copy(document);
        this.CreatedAt = new Date(CreatedAt.getTime());
        Object.freeze(this);
    }

    public get Document(): Record<string, JsonValue>
    {
        return JsonDocument.Copy(this.document);
    }
}
