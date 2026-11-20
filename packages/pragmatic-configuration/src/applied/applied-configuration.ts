import { CanonicalJson, ConfigurationValidator } from '@pragmatic-tech-ai/pragmatic-component';
import type { ComponentDescriptor, JsonValue } from '@pragmatic-tech-ai/pragmatic-component';
import type { ConfigurationVersion } from '../repository/configuration-version.js';
import { JsonDocument } from '../repository/json-document.js';
import { AppliedConfigurationError } from './applied-configuration-error.js';
import { AppliedConfigurationKeys } from './applied-configuration-keys.js';

/**
 * The configuration version applied to a deployment, as the tenant admin console writes it next to the deployment: the
 * realm and component, the version number, the component version and descriptor digest it was validated against and the
 * resolved document (defaults filled in, secret settings as secret references, never secret values). Its content hash
 * (the digest of its canonical JSON) goes on the deployment's pod template, so a new version rolls the deployment.
 */
export class AppliedConfiguration
{
    private static readonly DigestMismatch = 'the descriptor is not the one the version was validated against';
    private static readonly Invalid = 'the version does not validate against its descriptor';

    private readonly document: Record<string, JsonValue>;

    public constructor(
        public readonly Realm: string,
        public readonly Component: string,
        public readonly Version: number,
        public readonly ComponentVersion: string,
        public readonly DescriptorDigest: string,
        document: Record<string, JsonValue>,
    )
    {
        this.document = JsonDocument.Copy(document);
        Object.freeze(this);
    }

    /** The applied form of a saved version: re-validated against `descriptor` (the one the version was validated
     *  against, checked by digest) and resolved, so the component reads every default the console saw. */
    public static From(version: ConfigurationVersion, descriptor: ComponentDescriptor): AppliedConfiguration
    {
        if (descriptor.ContentDigest() !== version.DescriptorDigest) throw new AppliedConfigurationError(AppliedConfiguration.DigestMismatch);
        const validation = new ConfigurationValidator(descriptor).Validate(version.Document);
        if (validation.Configuration === undefined) throw new AppliedConfigurationError(AppliedConfiguration.Invalid);
        return new AppliedConfiguration(
            version.Scope.Realm,
            version.Scope.Component,
            version.Number,
            version.ComponentVersion,
            version.DescriptorDigest,
            validation.Configuration.ToJson(),
        );
    }

    public get Document(): Record<string, JsonValue>
    {
        return JsonDocument.Copy(this.document);
    }

    /** `pragmatic-config-<component>`. */
    public ObjectName(): string
    {
        return AppliedConfigurationKeys.ObjectNamePrefix + this.Component;
    }

    public ToJson(): Record<string, JsonValue>
    {
        return {
            [AppliedConfigurationKeys.Schema]: AppliedConfigurationKeys.SchemaVersion,
            [AppliedConfigurationKeys.Realm]: this.Realm,
            [AppliedConfigurationKeys.Component]: this.Component,
            [AppliedConfigurationKeys.Version]: this.Version,
            [AppliedConfigurationKeys.ComponentVersion]: this.ComponentVersion,
            [AppliedConfigurationKeys.DescriptorDigest]: this.DescriptorDigest,
            [AppliedConfigurationKeys.Document]: this.Document,
        };
    }

    /** The file the object carries and a component reads: canonical JSON. */
    public ToCanonicalJson(): string
    {
        return CanonicalJson.Stringify(this.ToJson());
    }

    /** `sha256:<hex>` of the canonical JSON: changes with every new version, document or descriptor. */
    public ContentHash(): string
    {
        return CanonicalJson.Digest(this.ToJson());
    }
}
