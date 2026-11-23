import { JsonDocument } from '../repository/json-document.js';
import { AppliedConfigurationKeys } from './applied-configuration-keys.js';

/** The applied document does not validate against a new release's descriptor: which settings must change, and why. */
export class ConfigurationPreparationRefusal
{
    private static readonly DigestKey = 'descriptorDigest';
    private static readonly ComponentVersionKey = 'componentVersion';
    private static readonly SettingsKey = 'settings';
    private static readonly ReasonKey = 'reason';

    public readonly Settings: readonly string[];

    public constructor(
        public readonly DescriptorDigest: string,
        public readonly ComponentVersion: string,
        settings: readonly string[],
        /** The validation errors in words (settings and rules only, never a value). */
        public readonly Reason: string,
    )
    {
        this.Settings = Object.freeze([...settings]);
        Object.freeze(this);
    }

    public ToJson(): Record<string, unknown>
    {
        const R = ConfigurationPreparationRefusal;
        return { [R.DigestKey]: this.DescriptorDigest, [R.ComponentVersionKey]: this.ComponentVersion, [R.SettingsKey]: [...this.Settings], [R.ReasonKey]: this.Reason };
    }

    /** A refusal as the annotation carries it; undefined for anything else. */
    public static FromJson(value: unknown): ConfigurationPreparationRefusal | undefined
    {
        const R = ConfigurationPreparationRefusal;
        if (!JsonDocument.IsObject(value)) return undefined;
        const digest = value[R.DigestKey];
        const version = value[R.ComponentVersionKey];
        const settings = value[R.SettingsKey];
        const reason = value[R.ReasonKey];
        if (typeof digest !== 'string' || typeof version !== 'string' || typeof reason !== 'string') return undefined;
        if (!Array.isArray(settings) || !settings.every(s => typeof s === 'string')) return undefined;
        return new ConfigurationPreparationRefusal(digest, version, settings as string[], reason);
    }
}

/**
 * Where a component's configuration stands for the descriptors of a release it is about to run, as the tenant admin
 * console records it on the `pragmatic-config-<component>` ConfigMap (R4): `pragmatic-tech.ai/prepared-digests` (the
 * descriptor digests a prepared entry exists for, comma separated), `pragmatic-tech.ai/preparation-refused` (a JSON
 * array of refusals) and `pragmatic-tech.ai/prepared-from` (the configuration hash of the applied file they were derived
 * from; the status holds only while it equals the ConfigMap's configuration-hash annotation). Whoever rolls the component onto a new image (the platform's installer) reads these and waits; it
 * never writes them. Immutable; an unreadable annotation reads as no status.
 */
export class ConfigurationPreparationStatus
{
    public static readonly Empty = new ConfigurationPreparationStatus([], [], undefined);
    private static readonly Separator = ',';
    private static readonly DigestPattern = AppliedConfigurationKeys.DigestPattern;

    public readonly Prepared: readonly string[];
    public readonly Refusals: readonly ConfigurationPreparationRefusal[];

    public constructor(
        prepared: readonly string[],
        refusals: readonly ConfigurationPreparationRefusal[],
        /** The configuration hash of the applied file this status was derived from (undefined: unknown, never current). */
        public readonly From: string | undefined = undefined,
    )
    {
        this.Prepared = Object.freeze([...new Set(prepared)].sort());
        this.Refusals = Object.freeze([...refusals].sort((a, b) => a.DescriptorDigest.localeCompare(b.DescriptorDigest)));
        Object.freeze(this);
    }

    /** The status a ConfigMap's annotations carry. */
    public static Of(annotations: unknown): ConfigurationPreparationStatus
    {
        const S = ConfigurationPreparationStatus;
        if (!JsonDocument.IsObject(annotations)) return S.Empty;
        const marks = annotations[AppliedConfigurationKeys.PreparedDigestsAnnotation];
        const prepared = typeof marks === 'string' ? marks.split(S.Separator).filter(d => S.DigestPattern.test(d)) : [];
        const from = annotations[AppliedConfigurationKeys.PreparedFromAnnotation];
        return new ConfigurationPreparationStatus(prepared, S.RefusalsOf(annotations[AppliedConfigurationKeys.PreparationRefusedAnnotation]), typeof from === 'string' && S.DigestPattern.test(from) ? from : undefined);
    }

    /** Whether this status was derived from the applied file whose configuration hash is `hash` (else it is stale). */
    public Holds(hash: string | undefined): boolean
    {
        return hash !== undefined && this.From === hash;
    }

    /** The status for the applied file `hash`: this one when derived from it, else an empty one (what was prepared from
     *  another file is stale). */
    public DerivedFrom(hash: string): ConfigurationPreparationStatus
    {
        return this.From === hash ? this : new ConfigurationPreparationStatus([], [], hash);
    }

    public IsPrepared(digest: string): boolean
    {
        return this.Prepared.includes(digest);
    }

    public RefusalFor(digest: string): ConfigurationPreparationRefusal | undefined
    {
        return this.Refusals.find(r => r.DescriptorDigest === digest);
    }

    /** Prepared for `digest`: its refusal, if any, is dropped. */
    public WithPrepared(digest: string): ConfigurationPreparationStatus
    {
        return new ConfigurationPreparationStatus([...this.Prepared, digest], this.Refusals.filter(r => r.DescriptorDigest !== digest), this.From);
    }

    /** Refused for the refusal's digest: its prepared mark, if any, is dropped and an earlier refusal replaced. */
    public WithRefusal(refusal: ConfigurationPreparationRefusal): ConfigurationPreparationStatus
    {
        const digest = refusal.DescriptorDigest;
        return new ConfigurationPreparationStatus(this.Prepared.filter(d => d !== digest), [...this.Refusals.filter(r => r.DescriptorDigest !== digest), refusal], this.From);
    }

    /** Neither prepared nor refused for any of `digests`. */
    public Without(digests: readonly string[]): ConfigurationPreparationStatus
    {
        return new ConfigurationPreparationStatus(this.Prepared.filter(d => !digests.includes(d)), this.Refusals.filter(r => !digests.includes(r.DescriptorDigest)), this.From);
    }

    /** The annotations, each only when it has something to say (the source alone: derived from that file, nothing prepared or refused yet). */
    public ToAnnotations(): Record<string, string>
    {
        const out: Record<string, string> = {};
        if (this.Prepared.length > 0) out[AppliedConfigurationKeys.PreparedDigestsAnnotation] = this.Prepared.join(ConfigurationPreparationStatus.Separator);
        if (this.Refusals.length > 0) out[AppliedConfigurationKeys.PreparationRefusedAnnotation] = JSON.stringify(this.Refusals.map(r => r.ToJson()));
        if (this.From !== undefined) out[AppliedConfigurationKeys.PreparedFromAnnotation] = this.From;
        return out;
    }

    /** `annotations` with this status in place of whatever status they carried. */
    public Over(annotations: Readonly<Record<string, string>>): Record<string, string>
    {
        const out = { ...annotations };
        delete out[AppliedConfigurationKeys.PreparedDigestsAnnotation];
        delete out[AppliedConfigurationKeys.PreparationRefusedAnnotation];
        delete out[AppliedConfigurationKeys.PreparedFromAnnotation];
        return { ...out, ...this.ToAnnotations() };
    }

    private static RefusalsOf(text: unknown): ConfigurationPreparationRefusal[]
    {
        if (typeof text !== 'string') return [];
        let parsed: unknown;
        try
        {
            parsed = JSON.parse(text);
        }
        catch
        {
            return [];
        }
        if (!Array.isArray(parsed)) return [];
        return parsed.map(item => ConfigurationPreparationRefusal.FromJson(item)).filter((r): r is ConfigurationPreparationRefusal => r !== undefined);
    }
}
