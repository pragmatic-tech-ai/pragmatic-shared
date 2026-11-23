import type { JsonValue } from '@pragmatic-tech-ai/pragmatic-component';
import { ConfigurationScope } from '../repository/configuration-scope.js';
import { JsonDocument } from '../repository/json-document.js';
import { AppliedConfiguration } from './applied-configuration.js';
import { AppliedConfigurationError } from './applied-configuration-error.js';
import { AppliedConfigurationKeys } from './applied-configuration-keys.js';

/** The ConfigMap the tenant admin console writes next to a deployment (members mirror the Kubernetes JSON). */
export interface IAppliedConfigMap
{
    apiVersion: string;
    kind: string;
    metadata: {
        name: string;
        namespace: string;
        labels: Record<string, string>;
        annotations: Record<string, string>;
    };
    data: Record<string, string>;
}

/**
 * Writes and reads the applied-configuration object: a `ConfigMap` named `pragmatic-config-<component>` whose one file
 * (`configuration.json`) is the applied configuration's canonical JSON, annotated with the version, descriptor digest,
 * realm and content hash. The deployment mounts it as a volume, so the component reads the file and needs no Kubernetes
 * API access; the content hash also goes on the pod template (`PodTemplateAnnotations`), so a new version rolls it.
 * Decoding is strict and its errors name the member, never the value.
 */
export class AppliedConfigurationCodec
{
    private static readonly DigestPattern = AppliedConfigurationKeys.DigestPattern;
    private static readonly Members = [
        AppliedConfigurationKeys.Schema,
        AppliedConfigurationKeys.Realm,
        AppliedConfigurationKeys.Component,
        AppliedConfigurationKeys.Version,
        AppliedConfigurationKeys.ComponentVersion,
        AppliedConfigurationKeys.DescriptorDigest,
        AppliedConfigurationKeys.Document,
    ];
    private static readonly NotJson = 'the file is not JSON';
    private static readonly NotObject = 'the file is not a JSON object';
    private static readonly UnknownMember = 'unknown member';
    private static readonly MissingMember = 'missing member';
    private static readonly BadMember = 'malformed member';
    private static readonly BadSchema = 'unsupported schema (expected 1)';
    private static readonly NotConfigMap = 'the object is not a v1 ConfigMap';
    private static readonly NoFile = 'the ConfigMap carries no configuration.json';
    private static readonly WrongName = 'the ConfigMap name does not match its component';
    private static readonly WrongHash = 'the configuration-hash annotation does not match the content';

    public static Encode(applied: AppliedConfiguration): string
    {
        return applied.ToCanonicalJson();
    }

    public static Decode(text: string): AppliedConfiguration
    {
        let value: unknown;
        try
        {
            value = JSON.parse(text);
        }
        catch
        {
            throw new AppliedConfigurationError(AppliedConfigurationCodec.NotJson);
        }
        if (!JsonDocument.IsObject(value)) throw new AppliedConfigurationError(AppliedConfigurationCodec.NotObject);
        return AppliedConfigurationCodec.FromJson(value);
    }

    public static ToConfigMap(applied: AppliedConfiguration, namespace: string): IAppliedConfigMap
    {
        return {
            apiVersion: AppliedConfigurationKeys.ApiVersion,
            kind: AppliedConfigurationKeys.Kind,
            metadata: {
                name: applied.ObjectName(),
                namespace,
                labels: {
                    [AppliedConfigurationKeys.ComponentLabel]: applied.Component,
                    [AppliedConfigurationKeys.ManagedByLabel]: AppliedConfigurationKeys.ManagedBy,
                },
                annotations: {
                    [AppliedConfigurationKeys.VersionAnnotation]: String(applied.Version),
                    [AppliedConfigurationKeys.DigestAnnotation]: applied.DescriptorDigest,
                    [AppliedConfigurationKeys.HashAnnotation]: applied.ContentHash(),
                    [AppliedConfigurationKeys.RealmAnnotation]: applied.Realm,
                },
            },
            data: { [AppliedConfigurationKeys.FileName]: AppliedConfigurationCodec.Encode(applied) },
        };
    }

    /** Reads a ConfigMap back (e.g. what the cluster holds), checking its name and hash annotation against the file. */
    public static FromConfigMap(object: unknown): AppliedConfiguration
    {
        if (!JsonDocument.IsObject(object)
            || object.apiVersion !== AppliedConfigurationKeys.ApiVersion
            || object.kind !== AppliedConfigurationKeys.Kind)
        {
            throw new AppliedConfigurationError(AppliedConfigurationCodec.NotConfigMap);
        }
        const data = object.data;
        const file = JsonDocument.IsObject(data) ? data[AppliedConfigurationKeys.FileName] : undefined;
        if (typeof file !== 'string') throw new AppliedConfigurationError(AppliedConfigurationCodec.NoFile);
        const applied = AppliedConfigurationCodec.Decode(file);
        const metadata = JsonDocument.IsObject(object.metadata) ? object.metadata : {};
        if (metadata.name !== applied.ObjectName()) throw new AppliedConfigurationError(AppliedConfigurationCodec.WrongName);
        const annotations = JsonDocument.IsObject(metadata.annotations) ? metadata.annotations : {};
        const hash = annotations[AppliedConfigurationKeys.HashAnnotation];
        if (hash !== undefined && hash !== applied.ContentHash()) throw new AppliedConfigurationError(AppliedConfigurationCodec.WrongHash);
        return applied;
    }

    /** The annotation to set on the deployment's pod template: a new value rolls the deployment. */
    public static PodTemplateAnnotations(applied: AppliedConfiguration): Record<string, string>
    {
        return { [AppliedConfigurationKeys.HashAnnotation]: applied.ContentHash() };
    }

    private static FromJson(json: Record<string, JsonValue>): AppliedConfiguration
    {
        for (const key of Object.keys(json))
        {
            if (!AppliedConfigurationCodec.Members.includes(key)) AppliedConfigurationCodec.Fail(AppliedConfigurationCodec.UnknownMember, key);
        }
        for (const key of AppliedConfigurationCodec.Members)
        {
            if (!(key in json)) AppliedConfigurationCodec.Fail(AppliedConfigurationCodec.MissingMember, key);
        }
        if (json[AppliedConfigurationKeys.Schema] !== AppliedConfigurationKeys.SchemaVersion) throw new AppliedConfigurationError(AppliedConfigurationCodec.BadSchema);
        const realm = AppliedConfigurationCodec.Text(json, AppliedConfigurationKeys.Realm);
        const component = AppliedConfigurationCodec.Text(json, AppliedConfigurationKeys.Component);
        AppliedConfigurationCodec.CheckScope(realm, component);
        const version = json[AppliedConfigurationKeys.Version];
        if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) AppliedConfigurationCodec.Fail(AppliedConfigurationCodec.BadMember, AppliedConfigurationKeys.Version);
        const componentVersion = AppliedConfigurationCodec.Text(json, AppliedConfigurationKeys.ComponentVersion);
        const digest = AppliedConfigurationCodec.Text(json, AppliedConfigurationKeys.DescriptorDigest);
        if (!AppliedConfigurationCodec.DigestPattern.test(digest)) AppliedConfigurationCodec.Fail(AppliedConfigurationCodec.BadMember, AppliedConfigurationKeys.DescriptorDigest);
        const document = json[AppliedConfigurationKeys.Document];
        if (!JsonDocument.IsObject(document)) AppliedConfigurationCodec.Fail(AppliedConfigurationCodec.BadMember, AppliedConfigurationKeys.Document);
        return new AppliedConfiguration(realm, component, version as number, componentVersion, digest, document as Record<string, JsonValue>);
    }

    private static CheckScope(realm: string, component: string): void
    {
        try
        {
            new ConfigurationScope(realm, component);
        }
        catch
        {
            AppliedConfigurationCodec.Fail(AppliedConfigurationCodec.BadMember, `${AppliedConfigurationKeys.Realm}/${AppliedConfigurationKeys.Component}`);
        }
    }

    private static Text(json: Record<string, JsonValue>, key: string): string
    {
        const value = json[key];
        if (typeof value !== 'string' || value === '') AppliedConfigurationCodec.Fail(AppliedConfigurationCodec.BadMember, key);
        return value as string;
    }

    private static Fail(reason: string, member: string): never
    {
        throw new AppliedConfigurationError(`${reason} '${member}'`);
    }
}
