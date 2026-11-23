import { join } from 'node:path';
import { ComponentDeclarations } from '@pragmatic-tech-ai/pragmatic-component';
import type { ComponentDeclaration } from '@pragmatic-tech-ai/pragmatic-component';
import { ConfigurationEnvironmentOverlay } from './configuration-environment-overlay.js';
import { ConfigurationRuntimeReader } from './configuration-runtime-reader.js';
import { ConfigurationStartError, ConfigurationStartReason } from './configuration-start-error.js';
import { MountedSecretStore } from './mounted-secret-store.js';
import type { RuntimeConfiguration } from './runtime-configuration.js';
import { SecretStoreDirectory } from './secret-store-directory.js';

/** What a component hands the start step. */
export interface ComponentStartOptions
{
    /** The component's own declaration: its descriptor, and the variable each setting is read from. */
    Declaration: ComponentDeclaration;
    /** The process environment, overlaid in place. */
    Env: NodeJS.ProcessEnv;
    /** The secret stores the configuration's references resolve through; default `ComponentStartConfiguration.Stores`. */
    Stores?: SecretStoreDirectory;
    /** Where resolved secrets are written; default `/run/pragmatic/secrets` (a memory-backed volume). */
    SecretsDir?: string;
    /** Run an applied document validated for another descriptor when it validates against this one (the tenant admin
     *  console alone: it prepares every other component's entry, so nothing prepares its own before it starts). */
    Revalidate?: boolean;
}

/** What the start step did: the applied version and realm (null when no configuration is mounted), the settings it
 *  set and those it left to the environment (an equal default), by name only (never a value). */
export class ComponentStartReport
{
    public static readonly None = new ComponentStartReport(null, null, [], []);

    public readonly Settings: readonly string[];
    public readonly Kept: readonly string[];
    /** Revalidated only: the members of the applied document this descriptor no longer declares, left behind. */
    public readonly Dropped: readonly string[];

    public constructor(
        public readonly Version: number | null,
        public readonly Realm: string | null,
        settings: readonly string[],
        kept: readonly string[] = [],
        /** The applied document was validated for another descriptor and re-validated against this one. */
        public readonly Revalidated: boolean = false,
        dropped: readonly string[] = [],
        /** Revalidating only: why an applied document of another descriptor was not used (the start went on without it). */
        public readonly Ignored: string | undefined = undefined,
    )
    {
        this.Settings = Object.freeze([...settings]);
        this.Kept = Object.freeze([...kept]);
        this.Dropped = Object.freeze([...dropped]);
        Object.freeze(this);
    }

    public get Applied(): boolean
    {
        return this.Version !== null;
    }
}

/** The process a component exits through when its configuration refuses the start. Its members mirror Node's `process`
 *  (lowercase, so `process` itself fits), not this codebase's PascalCase. */
export interface IStartProcess
{
    exit(code: number): never;
    readonly stderr: { write(text: string): boolean };
}

/**
 * The first thing every hive component's `Main` does: reads its applied configuration (the mounted
 * `pragmatic-config-<component>` file, `PRAGMATIC_CONFIGURATION_FILE` overriding the path), validates it against the
 * component's own descriptor, resolves its secret references and overlays the result onto the process environment
 * (`ConfigurationEnvironmentOverlay`), so the component's settings readers then read the configured values.
 *
 * No file means no configuration: the environment is left exactly as it was. A file that does not read, validate or
 * resolve refuses the start with `ConfigurationStartError` and its reason (C Ledger 9); `ApplyOrExit` turns that into
 * exit code 78 (EX_CONFIG) with the reason on stderr. It logs nothing else. `Revalidate` (the tenant admin console
 * only) carries an applied document of another descriptor over (`Dropped`), and starts without it when that does not
 * validate (`Ignored`, the environment left as it was).
 */
export class ComponentStartConfiguration
{
    public static readonly DefaultSecretsDir = '/run/pragmatic/secrets';
    /** Where the console's per-component Secret `pragmatic-secrets-<component>` is mounted (store `file`). */
    public static readonly MountedSecretsRoot = '/run/secrets/pragmatic';
    public static readonly FileStore = 'file';
    /** EX_CONFIG (sysexits.h): the configuration refuses the start. */
    public static readonly ExitCode = 78;
    private static readonly LineEnd = '\n';

    /** The stores a hive component resolves through: `file`, its mounted Secret. */
    public static Stores(component: string, root: string = ComponentStartConfiguration.MountedSecretsRoot): SecretStoreDirectory
    {
        return new SecretStoreDirectory().Add(ComponentStartConfiguration.FileStore, new MountedSecretStore(join(root, component)));
    }

    public static async Apply(options: ComponentStartOptions): Promise<ComponentStartReport>
    {
        const C = ComponentStartConfiguration;
        const declaration = options.Declaration;
        const stores = options.Stores ?? C.Stores(declaration.name);
        const reader = new ConfigurationRuntimeReader(ComponentDeclarations.Build(declaration), stores, options.Revalidate === true);
        let configuration: RuntimeConfiguration | undefined;
        try
        {
            configuration = await C.Read(reader, ConfigurationRuntimeReader.PathFrom(options.Env));
        }
        catch (error)
        {
            // Only a revalidating start (the console) goes on without a configuration it cannot carry over: refusing would
            // leave the tenant without the one component that prepares configurations.
            if (!(error instanceof ConfigurationStartError) || error.Reason !== ConfigurationStartReason.Unrevalidated) throw error;
            return new ComponentStartReport(null, null, [], [], false, [], error.message);
        }
        if (configuration === undefined) return ComponentStartReport.None;
        const overlay = new ConfigurationEnvironmentOverlay(declaration, options.SecretsDir ?? C.DefaultSecretsDir);
        const result = await overlay.Apply(configuration, options.Env);
        return new ComponentStartReport(configuration.Version, configuration.Realm, result.Applied, result.Kept, configuration.Revalidated, configuration.Dropped);
    }

    /** `Apply`, exiting with ExitCode and the reason when the configuration refuses the start. */
    public static async ApplyOrExit(options: ComponentStartOptions, process: IStartProcess = globalThis.process as unknown as IStartProcess): Promise<ComponentStartReport>
    {
        try
        {
            return await ComponentStartConfiguration.Apply(options);
        }
        catch (error)
        {
            if (!(error instanceof ConfigurationStartError)) throw error;
            process.stderr.write(`${options.Declaration.name}: ${error.message} (${error.Reason})${ComponentStartConfiguration.LineEnd}`);
            return process.exit(ComponentStartConfiguration.ExitCode);
        }
    }

    private static async Read(reader: ConfigurationRuntimeReader, path: string): Promise<RuntimeConfiguration | undefined>
    {
        try
        {
            return await reader.Read(path);
        }
        catch (error)
        {
            if (error instanceof ConfigurationStartError && error.Reason === ConfigurationStartReason.Missing) return undefined;
            throw error;
        }
    }
}
