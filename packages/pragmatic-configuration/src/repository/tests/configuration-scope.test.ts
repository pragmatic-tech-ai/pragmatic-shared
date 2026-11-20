import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApplyTarget } from '../apply-record.js';
import { ConfigurationScope } from '../configuration-scope.js';

test('a scope is a realm id and a component name that fits a Kubernetes object name', () =>
{
    const scope = new ConfigurationScope('realm-1.a_b', 'realm-sign-in');
    assert.equal(scope.Key(), 'realm-1.a_b/realm-sign-in');
    assert.ok(scope.Equals(new ConfigurationScope('realm-1.a_b', 'realm-sign-in')));
    assert.ok(!scope.Equals(new ConfigurationScope('realm-2', 'realm-sign-in')));
    for (const [realm, component] of [['', 'x'], ['realm/1', 'x'], ['realm', ''], ['realm', 'Realm'], ['realm', 'a_b'], ['realm', 'a'.repeat(47)]])
    {
        assert.throws(() => new ConfigurationScope(realm, component), `${realm} ${component}`);
    }
    assert.equal(new ConfigurationScope('realm', 'a'.repeat(46)).Component.length, 46);
});

test('an apply target is three DNS labels', () =>
{
    const target = new ApplyTarget('hive-one', 'realm-a', 'tenant-idp');
    assert.equal(target.Key(), 'hive-one/realm-a/tenant-idp');
    assert.ok(target.Equals(new ApplyTarget('hive-one', 'realm-a', 'tenant-idp')));
    for (const name of ['', 'Hive', 'hive_one', '-hive', 'hive-', 'a'.repeat(64)])
    {
        assert.throws(() => new ApplyTarget(name, 'realm-a', 'tenant-idp'), name);
        assert.throws(() => new ApplyTarget('hive', name, 'tenant-idp'), name);
        assert.throws(() => new ApplyTarget('hive', 'realm-a', name), name);
    }
});
