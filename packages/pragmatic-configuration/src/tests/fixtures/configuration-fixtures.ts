import { randomUUID } from 'node:crypto';
import { ComponentDescriptorBuilder, SettingType } from '@pragmatic-tech-ai/pragmatic-component';
import type { ComponentDescriptor, JsonValue } from '@pragmatic-tech-ai/pragmatic-component';
import type { IConfigurationClock } from '../../repository/configuration-clock.js';
import { ConfigurationScope } from '../../repository/configuration-scope.js';
import { ConfigurationSaveRequest } from '../../repository/configuration-save-request.js';

/** A clock the tests move by hand. */
export class TestClock implements IConfigurationClock
{
    private current: number;

    public constructor(start = Date.UTC(2026, 10, 20, 9, 0, 0))
    {
        this.current = start;
    }

    public Now(): Date
    {
        return new Date(this.current);
    }

    public Advance(milliseconds: number): void
    {
        this.current += milliseconds;
    }
}

/** A realm sign-in descriptor (two versions), documents and save requests. */
export class ConfigurationFixtures
{
    public static readonly Component = 'realm-sign-in';
    public static readonly Author = 'sub-admin-1';
    public static readonly SecretValue = 'google-client-secret-value-42';
    public static readonly SecretReferenceText = 'secret:realm/google/client-secret';

    public static Descriptor(version = '0.3.0', component = ConfigurationFixtures.Component): ComponentDescriptor
    {
        return new ComponentDescriptorBuilder(component, version)
            .Option('local', 'Local accounts kept by the realm', option => option
                .Setting('selfRegistration', SettingType.Boolean, setting => setting.Default(false))
                .Setting('passwordMinLength', SettingType.Integer, setting => setting.Default(12)))
            .Option('google', 'Sign in with Google', option => option
                .Setting('clientId', SettingType.String, setting => setting.Required())
                .Setting('clientSecret', SettingType.String, setting => setting.Required().Secret())
                .Setting('allowedDomains', SettingType.List))
            .Postgres()
            .Port('http', 8080)
            .Health('http', '/healthz')
            .Build();
    }

    public static Scope(component = ConfigurationFixtures.Component): ConfigurationScope
    {
        return new ConfigurationScope(`realm-${randomUUID()}`, component);
    }

    public static Document(passwordMinLength = 14): Record<string, JsonValue>
    {
        return {
            options: {
                local: { passwordMinLength },
                google: { clientId: 'client-1', clientSecret: ConfigurationFixtures.SecretReferenceText, allowedDomains: ['example.com'] },
            },
        };
    }

    public static LiteralSecretDocument(): Record<string, JsonValue>
    {
        return { options: { google: { clientId: 'client-1', clientSecret: ConfigurationFixtures.SecretValue } } };
    }

    public static Save(scope: ConfigurationScope, basedOn: number, document: unknown = ConfigurationFixtures.Document(), descriptor = ConfigurationFixtures.Descriptor()): ConfigurationSaveRequest
    {
        return new ConfigurationSaveRequest(scope, basedOn, document, descriptor, ConfigurationFixtures.Author, `edit on ${basedOn}`);
    }
}
