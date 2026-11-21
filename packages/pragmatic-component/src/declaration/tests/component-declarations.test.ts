import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SettingType } from '../../descriptor/setting-type.js'
import { ComponentDeclarations, type ComponentDeclaration } from '../component-declarations.js'

class DeclarationFixture
{
    public static readonly Version = '0.1.0'

    public static readonly Sample: ComponentDeclaration = {
        name: 'sample-app',
        version: DeclarationFixture.Version,
        options: [
            {
                name: 'core',
                description: 'Core.',
                settings: [
                    { name: 'port', type: SettingType.Integer, source: 'PRAGMATIC_PORT', default: 8080, description: 'Port.' },
                    { name: 'token', type: SettingType.String, source: 'PRAGMATIC_TOKEN_FILE', required: true, secret: true, description: 'Token.' },
                ],
            },
        ],
        roles: [{ name: 'app.admin', description: 'Admin.' }],
        postgres: true,
        ports: [{ name: 'http', number: 8080 }],
        health: { port: 'http', path: '/healthz' },
    }
}

describe('ComponentDeclarations', () =>
{
    it('builds the descriptor at the declaration\'s version (the shipping package\'s, not the release\'s)', () =>
    {
        assert.equal(ComponentDeclarations.Build(DeclarationFixture.Sample).Version, DeclarationFixture.Version)
        assert.equal(ComponentDeclarations.Build({ ...DeclarationFixture.Sample, version: '2.0.0' }).Version, '2.0.0')
    })

    it('builds options, settings (source as the description prefix), roles, storage, ports and health', () =>
    {
        const descriptor = ComponentDeclarations.Build(DeclarationFixture.Sample)
        assert.equal(descriptor.Name, 'sample-app')
        assert.equal(descriptor.Version, DeclarationFixture.Version)
        const [port, token] = descriptor.Options[0].Settings
        assert.deepEqual([port.Name, port.Default, port.Required, port.Secret, port.Description], ['port', 8080, false, false, 'PRAGMATIC_PORT: Port.'])
        assert.deepEqual([token.Name, token.Default, token.Required, token.Secret], ['token', undefined, true, true])
        assert.deepEqual(descriptor.Roles.map(role => role.Name), ['app.admin'])
        assert.equal(descriptor.Storage.Postgres, true)
        assert.deepEqual(descriptor.Endpoints.Ports.map(p => [p.Name, p.Number]), [['http', 8080]])
        assert.deepEqual([descriptor.Endpoints.Health?.Port, descriptor.Endpoints.Health?.Path], ['http', '/healthz'])
    })

    it('leaves the descriptor rules to the builder: a secret with a default is refused', () =>
    {
        const bad: ComponentDeclaration = {
            ...DeclarationFixture.Sample,
            options: [{ name: 'core', description: '', settings: [{ name: 'key', type: SettingType.String, source: 'PRAGMATIC_KEY', secret: true, default: 'x', description: '' }] }],
        }
        assert.throws(() => ComponentDeclarations.Build(bad), /cannot have a default/)
    })
})
