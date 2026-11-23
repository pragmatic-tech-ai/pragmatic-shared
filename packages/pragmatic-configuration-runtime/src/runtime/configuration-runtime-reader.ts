import { readFile, realpath } from 'node:fs/promises';
import { ConfigurationValidator } from '@pragmatic-tech-ai/pragmatic-component';
import type { ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component';
import { AppliedConfigurationCodec } from '../applied/applied-configuration-codec.js';
import { AppliedConfigurationEntries } from '../applied/applied-configuration-entries.js';
import { AppliedDocumentCarryOver } from '../applied/applied-document-carry-over.js';
import { AppliedConfigurationError } from '../applied/applied-configuration-error.js';
import { AppliedConfigurationKeys } from '../applied/applied-configuration-keys.js';
import type { AppliedConfiguration } from '../applied/applied-configuration.js';
import { ConfigurationStartError, ConfigurationStartReason } from './configuration-start-error.js';
import { RuntimeConfiguration } from './runtime-configuration.js';
import type { SecretStoreDirectory } from './secret-store-directory.js';
import type { SecretValue } from './secret-value.js';

/**
 * What a component calls at start: reads its applied configuration from the mounted file (the `pragmatic-config-
 * <component>` ConfigMap mounted as a volume, so no Kubernetes API access), refuses a configuration of another
 * component or one validated against another descriptor than this container's own, validates it, and resolves its
 * secret references through the realm's secrets home. It logs nothing; its errors never carry a secret value.
 *
 * The folder holds one entry per descriptor digest (AppliedConfigurationEntries): `configuration.json` when it was
 * validated for this container's descriptor, else the entry prepared beside it for that descriptor
 * (`configuration.json.sha256-<hex>`, same component and realm), else the start is refused (descriptor-mismatch, C
 * Ledger 9). A missing `configuration.json` means no configuration, whatever else the folder holds. Both files are read
 * from the one folder the applied file resolves to (a mounted ConfigMap swaps its whole folder at once), so a primary
 * and an entry of two different writes are never paired. Entries are looked up as `<applied file>.sha256-<hex>`; the
 * console writes them for `configuration.json` only.
 *
 * `revalidate` (the tenant admin console alone, which owns the configurations and prepares the entries) instead carries
 * an applied document of another descriptor over to its own (AppliedDocumentCarryOver: settings it no longer declares
 * are left behind, `RuntimeConfiguration.Dropped`), then leaves behind the settings that still fail, and runs what
 * remains (`Revalidated`); when even that does not validate (a required setting missing), the start is refused with
 * reason `unrevalidated`, which the start step turns into "no configuration".
 */
export class ConfigurationRuntimeReader
{
    public static readonly DefaultDirectory = '/etc/pragmatic/configuration';
    public static readonly DefaultPath = `${ConfigurationRuntimeReader.DefaultDirectory}/${AppliedConfigurationKeys.FileName}`;
    public static readonly PathVariable = 'PRAGMATIC_CONFIGURATION_FILE';

    private static readonly NotFound = 'ENOENT';
    private static readonly Encoding = 'utf8';
    private static readonly ErrorSeparator = '; ';
    private static readonly NonePrepared = '; no configuration prepared for it was found beside it';
    private static readonly EntryOtherDescriptor = 'the prepared entry names another descriptor than its file';
    private static readonly EntryOtherScope = 'the prepared entry is of another component or realm than configuration.json';

    public constructor(
        public readonly Descriptor: ComponentDescriptor,
        private readonly secrets: SecretStoreDirectory,
        private readonly revalidate: boolean = false,
    )
    {
    }

    /** The file to read: PRAGMATIC_CONFIGURATION_FILE when set and non-empty, else the default mount path. */
    public static PathFrom(environment: Readonly<Record<string, string | undefined>>): string
    {
        const path = environment[ConfigurationRuntimeReader.PathVariable];
        return path === undefined || path === '' ? ConfigurationRuntimeReader.DefaultPath : path;
    }

    public async Read(path: string = ConfigurationRuntimeReader.DefaultPath): Promise<RuntimeConfiguration>
    {
        // Resolved first, so the applied file and its entry are read from one folder (one write of the ConfigMap).
        const resolved = await ConfigurationRuntimeReader.Resolved(path);
        const primary = ConfigurationRuntimeReader.Decode(await ConfigurationRuntimeReader.ReadText(resolved), path);
        const selected = await this.Select(primary, resolved);
        const applied = selected.Applied;
        const validator = new ConfigurationValidator(this.Descriptor);
        let validation = validator.Validate(selected.Document);
        let dropped = selected.Dropped;
        if (validation.Configuration === undefined && selected.Revalidated)
        {
            // The console keeps every member that still validates: only the failing settings are left behind.
            const pruned = AppliedDocumentCarryOver.Without(selected.Document, AppliedDocumentCarryOver.MembersOf(validation.Errors));
            dropped = [...dropped, ...pruned.Dropped];
            validation = validator.Validate(pruned.Document);
        }
        if (validation.Configuration === undefined)
        {
            const errors = validation.Errors.map(error => error.toString()).join(ConfigurationRuntimeReader.ErrorSeparator);
            const reason = selected.Revalidated ? ConfigurationStartReason.Unrevalidated : ConfigurationStartReason.Invalid;
            throw new ConfigurationStartError(reason, `version ${applied.Version} of ${applied.Component} does not validate: ${errors}`);
        }
        const secrets = new Map<string, SecretValue>();
        for (const secret of validation.Configuration.SecretReferences())
        {
            const where = `${secret.Option}.${secret.Setting}`;
            secrets.set(RuntimeConfiguration.SecretKey(secret.Option, secret.Setting), await this.secrets.Resolve(secret.Reference, where));
        }
        return new RuntimeConfiguration(applied.Version, applied.ComponentVersion, applied.DescriptorDigest, validation.Configuration, secrets, applied.Realm, selected.Revalidated, dropped);
    }

    // The entry for this container's descriptor: the applied file, else the prepared entry beside it, else (revalidating)
    // the applied file to validate against this descriptor, else a refusal.
    private async Select(primary: AppliedConfiguration, path: string): Promise<{ Applied: AppliedConfiguration; Document: unknown; Revalidated: boolean; Dropped: readonly string[] }>
    {
        const R = ConfigurationRuntimeReader;
        const own = this.Descriptor;
        if (primary.Component !== own.Name)
        {
            throw new ConfigurationStartError(ConfigurationStartReason.ComponentMismatch, `the mounted configuration is for ${primary.Component}, this container is ${own.Name}`);
        }
        const digest = own.ContentDigest();
        if (primary.DescriptorDigest === digest) return { Applied: primary, Document: primary.Document, Revalidated: false, Dropped: [] };
        const entryPath = AppliedConfigurationEntries.PathOf(path, digest);
        const text = await R.ReadOptional(entryPath);
        if (text !== undefined)
        {
            const entry = R.Decode(text, entryPath);
            if (entry.DescriptorDigest !== digest) throw new ConfigurationStartError(ConfigurationStartReason.Malformed, `${entryPath}: ${R.EntryOtherDescriptor}`);
            if (entry.Component !== primary.Component || entry.Realm !== primary.Realm) throw new ConfigurationStartError(ConfigurationStartReason.Malformed, `${entryPath}: ${R.EntryOtherScope}`);
            return { Applied: entry, Document: entry.Document, Revalidated: false, Dropped: [] };
        }
        if (this.revalidate)
        {
            const carried = AppliedDocumentCarryOver.Carry(primary.Document, own);
            return { Applied: primary, Document: carried.Document, Revalidated: true, Dropped: carried.Dropped };
        }
        throw new ConfigurationStartError(
            ConfigurationStartReason.DescriptorMismatch,
            `configuration version ${primary.Version} of ${primary.Component} was validated against descriptor ${primary.DescriptorDigest} (component version ${primary.ComponentVersion}), `
            + `but this container's descriptor is ${digest} (component version ${own.Version})${R.NonePrepared}; save and apply a configuration version validated for ${own.Version}`,
        );
    }

    // The applied file through its folder's symlinks (a ConfigMap volume's `..data`), so its entry is read from the same
    // folder; the path itself when it does not resolve (the read then reports it).
    private static async Resolved(path: string): Promise<string>
    {
        try
        {
            return await realpath(path);
        }
        catch
        {
            return path;
        }
    }

    // A prepared entry's text, or undefined when there is none.
    private static async ReadOptional(path: string): Promise<string | undefined>
    {
        try
        {
            return await ConfigurationRuntimeReader.ReadText(path);
        }
        catch (error)
        {
            if (error instanceof ConfigurationStartError && error.Reason === ConfigurationStartReason.Missing) return undefined;
            throw error;
        }
    }

    private static async ReadText(path: string): Promise<string>
    {
        try
        {
            return await readFile(path, ConfigurationRuntimeReader.Encoding);
        }
        catch (error)
        {
            const code = (error as { code?: unknown }).code;
            if (code === ConfigurationRuntimeReader.NotFound)
            {
                throw new ConfigurationStartError(ConfigurationStartReason.Missing, `no applied configuration at ${path} (is the pragmatic-config ConfigMap mounted?)`);
            }
            throw new ConfigurationStartError(ConfigurationStartReason.Unreadable, `cannot read ${path}: ${String(code)}`);
        }
    }

    private static Decode(text: string, path: string): AppliedConfiguration
    {
        try
        {
            return AppliedConfigurationCodec.Decode(text);
        }
        catch (error)
        {
            if (!(error instanceof AppliedConfigurationError)) throw error;
            throw new ConfigurationStartError(ConfigurationStartReason.Malformed, `${path}: ${error.message}`);
        }
    }
}
