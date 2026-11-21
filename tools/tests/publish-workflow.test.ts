import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** .github/workflows/publish.yml, read as text (no YAML parser is installed in this workspace). */
class PublishWorkflow
{
    public static readonly File = path.resolve(__dirname, '..', '..', '.github', 'workflows', 'publish.yml');
    private static readonly SecretReference = /secrets\.([A-Z_]+)/g;

    public static Text(): string
    {
        return fs.readFileSync(PublishWorkflow.File, 'utf8');
    }

    /** The secrets the workflow names. */
    public static Secrets(text: string): string[]
    {
        return [...new Set([...text.matchAll(PublishWorkflow.SecretReference)].map(match => match[1]))];
    }
}

describe('publish workflow', () =>
{
    const text = PublishWorkflow.Text();

    it('runs on a pushed v* tag and on demand, nothing else', () =>
    {
        assert.match(text, /^on:\n {2}push:\n {4}tags: \['v\*'\]\n {2}workflow_dispatch:\n/m);
        assert.doesNotMatch(text, /^ {2}pull_request:/m);
        assert.doesNotMatch(text, /branches:/);
    });

    it('grants only packages: write and contents: read, and reads no secret but GITHUB_TOKEN', () =>
    {
        assert.match(text, /^ {4}permissions:\n {6}contents: read\n {6}packages: write\n {4}steps:/m);
        assert.doesNotMatch(text, /^permissions:/m);
        assert.deepEqual(PublishWorkflow.Secrets(text), ['GITHUB_TOKEN']);
        assert.ok(!text.includes('RELEASE_SIGNING_KEY'));
    });

    it('refuses a tag that is not v<workspace version>, then installs, builds and tests before it publishes', () =>
    {
        const steps = ['The tag names the workspace version', 'run: npm ci --no-audit --no-fund', 'run: npm run build\n','run: npm test --workspaces && npm run test:tools', 'npm run publish:packages -- $order'];
        const positions = steps.map(step => text.indexOf(step));
        assert.ok(positions.every(position => position > 0), JSON.stringify(positions));
        assert.deepEqual([...positions].sort((a, b) => a - b), positions);
        assert.ok(text.includes('if [ "$REF_TYPE" = tag ] && [ "$REF_NAME" != "v$version" ]; then'));
    });

    it('publishes every package in the root build order (the order the build script names them)', () =>
    {
        const root = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as { scripts: Record<string, string>; workspaces: string[] };
        const order = [...root.scripts.build.matchAll(/-w (packages\/[a-z0-9-]+)/g)].map(match => match[1]);
        assert.deepEqual([...order].sort(), [...root.workspaces].sort());
        assert.ok(text.includes("require('./package.json').scripts.build"));
        assert.ok(text.includes('matchAll(/-w (packages\\/[a-z0-9-]+)/g)'));
    });

    it('removes the npm credentials whatever the outcome', () =>
    {
        assert.match(text, /- name: Remove credentials\n {8}if: always\(\)\n {8}run: rm -f ~\/\.npmrc\n/);
    });
});
