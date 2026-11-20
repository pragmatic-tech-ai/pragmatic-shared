import { ComponentDescriptor } from '../../descriptor/component-descriptor.js';
import { ComponentDescriptorBuilder } from '../../descriptor/component-descriptor-builder.js';
import { SettingType } from '../../descriptor/setting-type.js';

/** A realm sign-in service: every identity source as an option, client secrets as secret settings, Postgres, no roles. */
export class RealmSignInDescriptor
{
    public static readonly Component = 'realm-sign-in';
    public static readonly Version = '0.3.0';

    public static Build(): ComponentDescriptor
    {
        return new ComponentDescriptorBuilder(RealmSignInDescriptor.Component, RealmSignInDescriptor.Version)
            .Option('local', 'Local accounts kept by the realm', option => option
                .Setting('selfRegistration', SettingType.Boolean, setting => setting.Default(false).Description('Visitors may create their own account'))
                .Setting('passwordMinLength', SettingType.Integer, setting => setting.Default(12))
                .Setting('sessionLifetime', SettingType.Duration, setting => setting.Default('8h')))
            .Option('google', 'Sign in with Google', option => option
                .Setting('clientId', SettingType.String, setting => setting.Required())
                .Setting('clientSecret', SettingType.String, setting => setting.Required().Secret().Description('OAuth client secret'))
                .Setting('allowedDomains', SettingType.List))
            .Option('entra', 'Sign in with Microsoft Entra ID', option => option
                .Setting('tenantId', SettingType.String, setting => setting.Required())
                .Setting('clientId', SettingType.String, setting => setting.Required())
                .Setting('clientSecret', SettingType.String, setting => setting.Required().Secret())
                .Setting('authority', SettingType.Url, setting => setting.Default('https://login.microsoftonline.com')))
            .Option('oidc', 'Any OpenID Connect provider', option => option
                .Setting('issuer', SettingType.Url, setting => setting.Required())
                .Setting('clientId', SettingType.String, setting => setting.Required())
                .Setting('clientSecret', SettingType.String, setting => setting.Secret())
                .Setting('scopes', SettingType.List, setting => setting.Default(['openid', 'profile', 'email'])))
            .Option('pragmatic', 'Sign in with Pragmatic', option => option
                .Setting('issuer', SettingType.Url, setting => setting.Default('https://id.pragmatic-tech.ai'))
                .Setting('clientId', SettingType.String, setting => setting.Required())
                .Setting('clientSecret', SettingType.String, setting => setting.Required().Secret()))
            .Postgres()
            .Port('http', 8080)
            .Health('http', '/healthz')
            .Build();
    }
}
