import { JsonDocument } from '../repository/json-document.js';
import type { AppliedConfiguration } from './applied-configuration.js';
import type { IAppliedConfigMap } from './applied-configuration-codec.js';
import { AppliedConfigurationCodec } from './applied-configuration-codec.js';
import { AppliedConfigurationError } from './applied-configuration-error.js';
import { AppliedConfigurationKeys } from './applied-configuration-keys.js';
import { ConfigurationPreparationStatus } from './configuration-preparation-status.js';

/**
 * The applied-configuration object holds one entry per descriptor digest (R1): `configuration.json` is the entry the
 * running pods were rolled onto (its hash is on the pod template), and beside it the console prepares one entry per other
 * descriptor a new release brings, `configuration.json.sha256-<hex>`, so during a roll the old pod reads its file and the
 * new pod its own. A prepared key never ends in `.json`, so a reader that takes every `*.json` file in the folder for a
 * configuration (the realm sign-in service's) never sees it, and a reader that knows only `configuration.json` (every
 * image before this format) reads exactly what it read before.
 */
export class AppliedConfigurationEntries
{
    private static readonly DigestPattern = /^sha256:[0-9a-f]{64}$/;
    private static readonly HexLength = 64;
    private static readonly BadDigest = 'a prepared entry needs a sha256 descriptor digest';
    private static readonly KeyMismatch = 'the prepared entry names another descriptor than its key';

    /** `configuration.json.sha256-<hex>` for `digest` (`sha256:<hex>`). */
    public static KeyOf(digest: string): string
    {
        return AppliedConfigurationKeys.FileName + AppliedConfigurationEntries.SuffixOf(digest);
    }

    /** The prepared entry's file beside the applied file at `primaryPath` (the mounted folder holds every key). */
    public static PathOf(primaryPath: string, digest: string): string
    {
        return primaryPath + AppliedConfigurationEntries.SuffixOf(digest);
    }

    /** The descriptor digest a prepared entry key names; undefined for any other key. */
    public static DigestOfKey(key: string): string | undefined
    {
        const prefix = AppliedConfigurationKeys.FileName + AppliedConfigurationKeys.PreparedEntryInfix;
        if (!key.startsWith(prefix)) return undefined;
        const digest = AppliedConfigurationKeys.DigestAlgorithmPrefix + key.slice(prefix.length);
        return AppliedConfigurationEntries.DigestPattern.test(digest) ? digest : undefined;
    }

    /** Every prepared entry of a ConfigMap, by descriptor digest; an entry that does not decode, or names another
     *  descriptor than its key, throws AppliedConfigurationError naming the key. */
    public static Prepared(object: unknown): ReadonlyMap<string, AppliedConfiguration>
    {
        const E = AppliedConfigurationEntries;
        const data = JsonDocument.IsObject(object) && JsonDocument.IsObject(object.data) ? object.data : {};
        const out = new Map<string, AppliedConfiguration>();
        for (const key of Object.keys(data).sort())
        {
            const digest = E.DigestOfKey(key);
            const text = data[key];
            if (digest === undefined || typeof text !== 'string') continue;
            let entry: AppliedConfiguration;
            try
            {
                entry = AppliedConfigurationCodec.Decode(text);
            }
            catch (error)
            {
                throw new AppliedConfigurationError(`${key}: ${(error as Error).message}`);
            }
            if (entry.DescriptorDigest !== digest) throw new AppliedConfigurationError(`${key}: ${E.KeyMismatch}`);
            out.set(digest, entry);
        }
        return out;
    }

    /** `configMap` with `entry` prepared beside its applied file (replacing an earlier entry for that digest) and marked
     *  prepared in its status; the applied file and its hash annotation stay as they are. A fresh object. */
    public static With(configMap: IAppliedConfigMap, entry: AppliedConfiguration): IAppliedConfigMap
    {
        const copy = structuredClone(configMap);
        const digest = entry.DescriptorDigest;
        copy.data[AppliedConfigurationEntries.KeyOf(digest)] = entry.ToCanonicalJson();
        copy.metadata.annotations = ConfigurationPreparationStatus.Of(copy.metadata.annotations).WithPrepared(digest).Over(copy.metadata.annotations);
        return copy;
    }

    /** `configMap` without the entries (and status) of `digests`. A fresh object. */
    public static Without(configMap: IAppliedConfigMap, digests: readonly string[]): IAppliedConfigMap
    {
        const copy = structuredClone(configMap);
        for (const digest of digests) delete copy.data[AppliedConfigurationEntries.KeyOf(digest)];
        copy.metadata.annotations = ConfigurationPreparationStatus.Of(copy.metadata.annotations).Without(digests).Over(copy.metadata.annotations);
        return copy;
    }

    private static SuffixOf(digest: string): string
    {
        const E = AppliedConfigurationEntries;
        if (!E.DigestPattern.test(digest)) throw new AppliedConfigurationError(E.BadDigest);
        return AppliedConfigurationKeys.PreparedEntryInfix + digest.slice(-E.HexLength);
    }
}
