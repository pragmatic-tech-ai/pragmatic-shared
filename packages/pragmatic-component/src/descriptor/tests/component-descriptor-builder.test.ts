import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ComponentDescriptorBuilder } from '../component-descriptor-builder.js';
import { ComponentDescriptorError } from '../component-descriptor-error.js';
import { SettingType } from '../setting-type.js';
import { RealmSignInDescriptor } from '../../tests/fixtures/realm-sign-in-descriptor.js';

class Fails
{
    public static With(build: () => unknown, pattern: RegExp): void
    {
        assert.throws(build, (error: unknown) => error instanceof ComponentDescriptorError && pattern.test(error.message));
    }
}

describe('ComponentDescriptorBuilder', () =>
{
    it('builds the realm sign-in descriptor', () =>
    {
        const descriptor = RealmSignInDescriptor.Build();
        assert.equal(descriptor.Name, 'realm-sign-in');
        assert.equal(descriptor.Version, '0.3.0');
        assert.deepEqual(descriptor.Options.map(option => option.Name), ['local', 'google', 'entra', 'oidc', 'pragmatic']);
        assert.deepEqual(descriptor.Roles, []);
        assert.equal(descriptor.Storage.Postgres, true);
        assert.deepEqual(descriptor.Endpoints.Ports.map(port => [port.Name, port.Number]), [['http', 8080]]);
        assert.equal(descriptor.Endpoints.Health?.Port, 'http');
        assert.equal(descriptor.Endpoints.Health?.Path, '/healthz');
        const secret = descriptor.Option('google')?.Setting('clientSecret');
        assert.equal(secret?.Secret, true);
        assert.equal(secret?.Required, true);
        assert.equal(secret?.Description, 'OAuth client secret');
        assert.deepEqual(descriptor.Option('oidc')?.Setting('scopes')?.Default, ['openid', 'profile', 'email']);
        assert.equal(descriptor.Option('nope'), undefined);
        assert.equal(descriptor.Option('local')?.Setting('nope'), undefined);
    });

    it('defaults: no storage, no endpoints, empty descriptions, optional non-secret settings', () =>
    {
        const descriptor = new ComponentDescriptorBuilder('bare', '1.0.0')
            .Option('core', '', option => option.Setting('level', SettingType.String))
            .Build();
        assert.equal(descriptor.Storage.Postgres, false);
        assert.deepEqual(descriptor.Endpoints.Ports, []);
        assert.equal(descriptor.Endpoints.Health, undefined);
        const setting = descriptor.Option('core')?.Setting('level');
        assert.equal(setting?.Required, false);
        assert.equal(setting?.Secret, false);
        assert.equal(setting?.Default, undefined);
        assert.equal(setting?.Description, '');
    });

    it('declares application roles', () =>
    {
        const descriptor = new ComponentDescriptorBuilder('app', '1.0.0').Role('reader', 'Reads').Role('writer', 'Writes').Build();
        assert.deepEqual(descriptor.Roles.map(role => [role.Name, role.Description]), [['reader', 'Reads'], ['writer', 'Writes']]);
    });

    it('builds an immutable descriptor', () =>
    {
        const descriptor = RealmSignInDescriptor.Build();
        assert.equal(Object.isFrozen(descriptor), true);
        assert.equal(Object.isFrozen(descriptor.Options), true);
        assert.equal(Object.isFrozen(descriptor.Options[0]), true);
        assert.equal(Object.isFrozen(descriptor.Options[0].Settings), true);
        assert.equal(Object.isFrozen(descriptor.Options[0].Settings[0]), true);
        assert.equal(Object.isFrozen(descriptor.Option('oidc')?.Setting('scopes')?.Default), true);
        assert.equal(Object.isFrozen(descriptor.Roles), true);
        assert.equal(Object.isFrozen(descriptor.Storage), true);
        assert.equal(Object.isFrozen(descriptor.Endpoints), true);
        assert.equal(Object.isFrozen(descriptor.Endpoints.Ports), true);
    });

    it('does not share a default array with the caller', () =>
    {
        const scopes = ['openid'];
        const descriptor = new ComponentDescriptorBuilder('app', '1.0.0').Option('o', '', option => option.Setting('scopes', SettingType.List, setting => setting.Default(scopes))).Build();
        scopes.push('email');
        assert.deepEqual(descriptor.Option('o')?.Setting('scopes')?.Default, ['openid']);
    });

    it('refuses an invalid component name or version', () =>
    {
        Fails.With(() => new ComponentDescriptorBuilder('Bad Name', '1.0.0').Build(), /component name/);
        Fails.With(() => new ComponentDescriptorBuilder('app', '1.0').Build(), /version/);
        assert.equal(new ComponentDescriptorBuilder('app', '0.1.0-early.3+build.7').Build().Version, '0.1.0-early.3+build.7');
    });

    it('refuses duplicate option, setting and role names', () =>
    {
        Fails.With(() => new ComponentDescriptorBuilder('app', '1.0.0').Option('a', '', option => option).Option('a', '', option => option).Build(), /duplicate option 'a'/);
        Fails.With(() => new ComponentDescriptorBuilder('app', '1.0.0').Option('a', '', option => option.Setting('s', SettingType.String).Setting('s', SettingType.Integer)).Build(), /duplicate setting 'a.s'/);
        Fails.With(() => new ComponentDescriptorBuilder('app', '1.0.0').Role('r', '').Role('r', '').Build(), /duplicate role 'r'/);
    });

    it('refuses invalid option, setting and role names', () =>
    {
        Fails.With(() => new ComponentDescriptorBuilder('app', '1.0.0').Option('A b', '', option => option).Build(), /option name/);
        Fails.With(() => new ComponentDescriptorBuilder('app', '1.0.0').Option('a', '', option => option.Setting('1x', SettingType.String)).Build(), /setting name/);
        Fails.With(() => new ComponentDescriptorBuilder('app', '1.0.0').Role('', '').Build(), /role name/);
        assert.equal(new ComponentDescriptorBuilder('app', '1.0.0').Role('realm.admin', '').Build().Roles[0].Name, 'realm.admin');
    });

    it('refuses a default on a secret setting', () =>
    {
        Fails.With(() => new ComponentDescriptorBuilder('app', '1.0.0').Option('a', '', option => option.Setting('key', SettingType.String, setting => setting.Secret().Default('x'))).Build(), /secret setting 'a.key' cannot have a default/);
    });

    it('refuses a secret setting that is not a string', () =>
    {
        Fails.With(() => new ComponentDescriptorBuilder('app', '1.0.0').Option('a', '', option => option.Setting('key', SettingType.Integer, setting => setting.Secret())).Build(), /secret setting 'a.key' must be of type string/);
    });

    it('refuses a default on a required setting', () =>
    {
        Fails.With(() => new ComponentDescriptorBuilder('app', '1.0.0').Option('a', '', option => option.Setting('n', SettingType.Integer, setting => setting.Required().Default(1))).Build(), /required setting 'a.n' cannot have a default/);
    });

    it('refuses a default of the wrong type', () =>
    {
        const cases: [SettingType, unknown][] = [
            [SettingType.String, 1], [SettingType.Integer, 1.5], [SettingType.Integer, '1'], [SettingType.Boolean, 'true'],
            [SettingType.Url, 'not a url'], [SettingType.Duration, '5 minutes'], [SettingType.List, ['a', 1]], [SettingType.List, 'a'],
        ];
        for (const [type, value] of cases)
        {
            Fails.With(() => new ComponentDescriptorBuilder('app', '1.0.0').Option('a', '', option => option.Setting('s', type, setting => setting.Default(value as never))).Build(), /default of setting 'a.s' is not a valid/);
        }
    });

    it('refuses an unknown setting type', () =>
    {
        Fails.With(() => new ComponentDescriptorBuilder('app', '1.0.0').Option('a', '', option => option.Setting('s', 'float' as SettingType)).Build(), /setting 'a.s' has an unknown type/);
    });

    it('refuses invalid ports and a health endpoint on an undeclared port', () =>
    {
        Fails.With(() => new ComponentDescriptorBuilder('app', '1.0.0').Port('http', 0).Build(), /port number/);
        Fails.With(() => new ComponentDescriptorBuilder('app', '1.0.0').Port('http', 65536).Build(), /port number/);
        Fails.With(() => new ComponentDescriptorBuilder('app', '1.0.0').Port('Http', 80).Build(), /port name/);
        Fails.With(() => new ComponentDescriptorBuilder('app', '1.0.0').Port('http', 80).Port('http', 81).Build(), /duplicate port 'http'/);
        Fails.With(() => new ComponentDescriptorBuilder('app', '1.0.0').Port('a', 80).Port('b', 80).Build(), /duplicate port number 80/);
        Fails.With(() => new ComponentDescriptorBuilder('app', '1.0.0').Port('http', 80).Health('admin', '/healthz').Build(), /health endpoint port 'admin'/);
        Fails.With(() => new ComponentDescriptorBuilder('app', '1.0.0').Port('http', 80).Health('http', 'healthz').Build(), /health path/);
    });
});
