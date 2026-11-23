import { chmod, lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CanonicalJson } from '@pragmatic-tech-ai/pragmatic-component';
import type { ComponentDeclaration, SettingDeclaration } from '@pragmatic-tech-ai/pragmatic-component';
import { ConfigurationStartError, ConfigurationStartReason } from './configuration-start-error.js';
import type { RuntimeConfiguration } from './runtime-configuration.js';
import { SettingValueEncoding } from './setting-value-encoding.js';

/** What an overlay did, by setting name (`<option>.<setting>`) only, never a value. */
export class OverlayResult
{
    public readonly Applied: readonly string[];
    /** Configured settings whose value equals the descriptor default and whose variable the environment already set:
     *  the environment's value was kept. */
    public readonly Kept: readonly string[];

    public constructor(applied: readonly string[], kept: readonly string[])
    {
        this.Applied = Object.freeze([...applied]);
        this.Kept = Object.freeze([...kept]);
        Object.freeze(this);
    }
}

/**
 * Lays a component's applied configuration over its process environment, by the variables its declaration already
 * names (each setting's `source`), so the component's own settings readers stay as they are.
 *
 * - A configured setting of an enabled option overrides its variable, encoded per type (`SettingValueEncoding`).
 * - The applied document carries the descriptor defaults filled in, so it cannot tell a default the admin left alone
 *   from one typed in: a value equal to the descriptor default does not override a variable the environment already
 *   sets to a non-empty value (such settings are reported as kept). Unconfigured settings (and options not enabled)
 *   keep the environment's value, or the component's own default.
 * - A secret never reaches the environment: its value is written to `<secrets>/<option>.<setting>` (mode 0400, never
 *   through an existing path) and its file variable (`<source>_FILE`, or `source` itself when it already names a file)
 *   points at it; the plain variable is removed, so the configured secret wins over one the deployment injects.
 * - Every run first empties the secrets directory (a per-pod memory-backed volume that survives an in-place restart),
 *   files and links alike, so a restart rewrites the files instead of finding stale ones; the directory is created
 *   only when a secret is written.
 * - Settings without a `source` are read by the component from its applied configuration document; they are skipped.
 *
 * It logs nothing (C Ledger 10). A file-system failure refuses the start (`secrets-unwritable`); a value that does not
 * encode as its declared type refuses it (`invalid`, naming the setting).
 */
export class ConfigurationEnvironmentOverlay
{
    public static readonly FileSuffix = '_FILE';
    public static readonly SecretFileMode = 0o400;
    private static readonly DirectoryMode = 0o700;
    private static readonly WritableMode = 0o600;
    private static readonly NameSeparator = '.';
    private static readonly CreateOnly = 'wx';
    private static readonly NotFound = 'ENOENT';
    /** A path whose parent is a file: there is no directory, so nothing to empty (POSIX; Windows answers ENOENT). */
    private static readonly NotDirectory = 'ENOTDIR';
    private static readonly Unwritable = 'cannot write the resolved secrets under';
    private static readonly NotEncodable = 'does not hold a value of its declared type';

    public constructor(
        private readonly declaration: ComponentDeclaration,
        public readonly SecretsDirectory: string,
    )
    {
    }

    /** The variable that names a secret setting's file. */
    public static FileVariable(source: string): string
    {
        const O = ConfigurationEnvironmentOverlay;
        return source.endsWith(O.FileSuffix) ? source : source + O.FileSuffix;
    }

    /** `<option>.<setting>`: how a setting is named in a start report and in its secret file's name. */
    public static SettingName(option: string, setting: string): string
    {
        return option + ConfigurationEnvironmentOverlay.NameSeparator + setting;
    }

    /** The file a secret setting is written to. */
    public SecretFile(option: string, setting: string): string
    {
        return join(this.SecretsDirectory, ConfigurationEnvironmentOverlay.SettingName(option, setting));
    }

    /** Overlays `configuration` onto `env` in place. */
    public async Apply(configuration: RuntimeConfiguration, env: NodeJS.ProcessEnv): Promise<OverlayResult>
    {
        await this.Guard(() => this.ClearSecrets());
        const applied: string[] = [];
        const kept: string[] = [];
        for (const option of this.declaration.options)
        {
            if (!configuration.IsEnabled(option.name)) continue;
            for (const setting of option.settings)
            {
                if (setting.source === undefined) continue;
                const name = ConfigurationEnvironmentOverlay.SettingName(option.name, setting.name);
                const outcome = setting.secret === true
                    ? await this.ApplySecret(configuration, option.name, setting, setting.source, env)
                    : ConfigurationEnvironmentOverlay.ApplyValue(configuration, option.name, setting, setting.source, env, name);
                if (outcome === true) applied.push(name);
                else if (outcome === false) kept.push(name);
            }
        }
        return new OverlayResult(applied, kept);
    }

    // true: written; undefined: nothing configured.
    private async ApplySecret(configuration: RuntimeConfiguration, option: string, setting: SettingDeclaration, source: string, env: NodeJS.ProcessEnv): Promise<true | undefined>
    {
        const O = ConfigurationEnvironmentOverlay;
        const secret = configuration.Secret(option, setting.name);
        if (secret === undefined) return undefined;
        const file = this.SecretFile(option, setting.name);
        await this.Guard(async () =>
        {
            await mkdir(this.SecretsDirectory, { recursive: true, mode: O.DirectoryMode });
            await writeFile(file, secret.Reveal(), { mode: O.SecretFileMode, flag: O.CreateOnly });
            await chmod(file, O.SecretFileMode);
        });
        const variable = O.FileVariable(source);
        env[variable] = file;
        if (variable !== source) delete env[source];
        return true;
    }

    // true: overridden; false: the environment's value kept (an equal default); undefined: nothing configured.
    private static ApplyValue(configuration: RuntimeConfiguration, option: string, setting: SettingDeclaration, source: string, env: NodeJS.ProcessEnv, name: string): boolean | undefined
    {
        const O = ConfigurationEnvironmentOverlay;
        const value = configuration.Value(option, setting.name);
        if (value === undefined) return undefined;
        const current = env[source];
        if (current !== undefined && current !== '' && O.IsDefault(setting, value)) return false;
        let text: string;
        try
        {
            text = SettingValueEncoding.Encode(setting.type, value);
        }
        catch
        {
            throw new ConfigurationStartError(ConfigurationStartReason.Invalid, `${name} ${O.NotEncodable} (${setting.type})`);
        }
        env[source] = text;
        return true;
    }

    private static IsDefault(setting: SettingDeclaration, value: unknown): boolean
    {
        return setting.default !== undefined && CanonicalJson.Stringify(setting.default) === CanonicalJson.Stringify(value);
    }

    // Removes every entry but directories (files and links alike, a link never followed); an absent directory is empty.
    private async ClearSecrets(): Promise<void>
    {
        const O = ConfigurationEnvironmentOverlay;
        let names: string[];
        try
        {
            names = await readdir(this.SecretsDirectory);
        }
        catch (error)
        {
            const code = (error as { code?: unknown }).code;
            if (code === O.NotFound || code === O.NotDirectory) return;
            throw error;
        }
        for (const name of names)
        {
            const path = join(this.SecretsDirectory, name);
            const entry = await lstat(path);
            if (entry.isDirectory()) continue;
            // A read-only file cannot be unlinked on Windows; elsewhere this is harmless.
            if (entry.isFile()) await chmod(path, O.WritableMode);
            await unlink(path);
        }
    }

    // A file-system failure refuses the start, naming the directory and the error code only.
    private async Guard(run: () => Promise<void>): Promise<void>
    {
        try
        {
            await run();
        }
        catch (error)
        {
            const code = (error as { code?: unknown }).code;
            throw new ConfigurationStartError(ConfigurationStartReason.SecretsUnwritable, `${ConfigurationEnvironmentOverlay.Unwritable} ${this.SecretsDirectory}: ${String(code)}`);
        }
    }
}
