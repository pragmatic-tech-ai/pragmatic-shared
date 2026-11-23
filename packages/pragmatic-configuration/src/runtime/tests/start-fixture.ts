import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComponentDeclarations, SettingType } from '@pragmatic-tech-ai/pragmatic-component';
import type { ComponentDeclaration, JsonValue } from '@pragmatic-tech-ai/pragmatic-component';
import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity';
import { AppliedConfiguration } from '../../applied/applied-configuration.js';
import { SecretStoreDirectory } from '../secret-store-directory.js';

/** A read-only map store for the start-step tests. */
export class FixedSecretStore implements ISecretStore
{
    public constructor(private readonly secrets: ReadonlyMap<string, string>)
    {
    }

    public Get(reference: string): Promise<string | null>
    {
        return Promise.resolve(this.secrets.get(reference) ?? null);
    }

    public Put(): Promise<void>
    {
        return Promise.resolve();
    }

    public Delete(): Promise<void>
    {
        return Promise.resolve();
    }
}

/** A component declared the way the hive components declare theirs, its applied files and a scratch folder. */
export class StartFixture
{
    public static readonly Name = 'pragmatic-test-agent';
    public static readonly Realm = 'realm-acme';
    public static readonly Token = 'token-value-7f3a';
    public static readonly Key = 'key-value-9c1d';
    public static readonly TokenReference = 'secret:file/agent-token';
    public static readonly KeyReference = 'secret:file/agent-key';

    public static Declaration(version = '0.1.0'): ComponentDeclaration
    {
        return {
            name: StartFixture.Name,
            version,
            options: [
                {
                    name: 'core',
                    description: 'The agent.',
                    settings: [
                        { name: 'registryUrl', type: SettingType.Url, source: 'TEST_REGISTRY_URL', required: true, description: 'Where to poll.' },
                        { name: 'pollIntervalMs', type: SettingType.Integer, source: 'TEST_POLL_INTERVAL_MS', default: 30000, description: 'Poll interval.' },
                        { name: 'verbose', type: SettingType.Boolean, source: 'TEST_VERBOSE', description: 'Verbose.' },
                        { name: 'hosts', type: SettingType.List, source: 'TEST_HOSTS', description: 'Hosts.' },
                        { name: 'token', type: SettingType.String, source: 'TEST_TOKEN', secret: true, description: 'Bearer token.' },
                        { name: 'key', type: SettingType.String, source: 'TEST_KEY_FILE', secret: true, description: 'Key file.' },
                        { name: 'inDocument', type: SettingType.String, description: 'Read from the document.' },
                    ],
                },
                {
                    name: 'extra',
                    description: 'An option left disabled.',
                    settings: [
                        { name: 'mode', type: SettingType.String, source: 'TEST_EXTRA_MODE', description: 'Mode.' },
                    ],
                },
            ],
            roles: [],
            postgres: false,
            ports: [],
        };
    }

    public static Applied(core: Record<string, JsonValue>, version = 4, declaration = StartFixture.Declaration()): AppliedConfiguration
    {
        const descriptor = ComponentDeclarations.Build(declaration);
        return new AppliedConfiguration(StartFixture.Realm, declaration.name, version, descriptor.Version, descriptor.ContentDigest(), { options: { core } });
    }

    public static Stores(secrets: ReadonlyMap<string, string> = new Map([['agent-token', StartFixture.Token], ['agent-key', StartFixture.Key]])): SecretStoreDirectory
    {
        return new SecretStoreDirectory().Add('file', new FixedSecretStore(secrets));
    }

    /** Runs `body` in a fresh folder; `Configuration` writes the mounted file into it. */
    public static async InFolder(body: (folder: string) => Promise<void>): Promise<void>
    {
        const folder = await mkdtemp(join(tmpdir(), 'pragmatic-start-'));
        try
        {
            await body(folder);
        }
        finally
        {
            await rm(folder, { recursive: true, force: true });
        }
    }

    public static async Configuration(folder: string, applied: AppliedConfiguration | string): Promise<string>
    {
        const path = join(folder, 'configuration.json');
        await writeFile(path, typeof applied === 'string' ? applied : applied.ToCanonicalJson(), 'utf8');
        return path;
    }
}
