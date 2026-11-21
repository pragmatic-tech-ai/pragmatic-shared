import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** .github/workflows/publish.yml, read as text (no YAML parser is installed in this workspace). */
class PublishWorkflow
{
    public static readonly File = path.resolve(__dirname, '..', '..', '.github', 'workflows', 'publish.yml');
    private static readonly SecretReference = /secrets\.([A-Z_]+)/g;
    private static readonly JobHeader = /^ {2}([\w-]+):$/;

    public static Text(): string
    {
        return fs.readFileSync(PublishWorkflow.File, 'utf8');
    }

    /** The secrets the workflow names. */
    public static Secrets(text: string): string[]
    {
        return [...new Set([...text.matchAll(PublishWorkflow.SecretReference)].map(match => match[1]))];
    }

    /** Each job's text by name. */
    public static Jobs(text: string): Map<string, string>
    {
        const jobs = new Map<string, string>();
        const lines = text.slice(text.indexOf('\njobs:\n') + '\njobs:\n'.length).split('\n');
        let current: string | undefined;
        for (const line of lines)
        {
            const header = PublishWorkflow.JobHeader.exec(line);
            if (header !== null)
            {
                current = header[1];
                jobs.set(current, '');
            }
            else if (current !== undefined)
            {
                jobs.set(current, jobs.get(current) + line + '\n');
            }
        }
        return jobs;
    }
}

describe('publish workflow', () =>
{
    const text = PublishWorkflow.Text();
    const jobs = PublishWorkflow.Jobs(text);
    const test = jobs.get('test') ?? '';
    const publish = jobs.get('publish') ?? '';

    it('runs on a pushed v* tag and on demand from main or a tag, nothing else', () =>
    {
        assert.match(text, /^on:\n {2}push:\n {4}tags: \['v\*'\]\n {2}workflow_dispatch:\n/m);
        assert.doesNotMatch(text, /^ {2}pull_request:/m);
        assert.doesNotMatch(text, /branches:/);
        assert.match(test, /^ {4}if: github\.ref_type == 'tag' \|\| github\.ref == 'refs\/heads\/main'\n/m);
        assert.match(publish, /^ {4}needs: test\n/m);
    });

    it('tests with a read-only token and publishes from a separate job, the only one with packages: write', () =>
    {
        assert.deepEqual([...jobs.keys()], ['test', 'publish']);
        assert.match(test, /^ {4}permissions:\n {6}contents: read\n {6}packages: read\n/m);
        assert.match(publish, /^ {4}permissions:\n {6}contents: read\n {6}packages: write\n/m);
        assert.doesNotMatch(text, /^permissions:/m);
        assert.deepEqual(PublishWorkflow.Secrets(text), ['GITHUB_TOKEN']);
        assert.ok(!text.includes('RELEASE_SIGNING_KEY'));
        assert.ok(!test.includes('publish:packages'));
    });

    it('runs no install script while the write token is on disk', () =>
    {
        const installs = publish.split('\n').filter(line => /npm (ci|install)\b/.test(line));
        assert.ok(installs.length >= 3, JSON.stringify(installs));
        for (const line of installs)
        {
            assert.ok(line.includes('--ignore-scripts'), line);
        }
    });

    it('pins every action by commit sha', () =>
    {
        const uses = text.split('\n').filter(line => /^\s*(- )?uses: /.test(line));
        assert.ok(uses.length >= 4);
        for (const line of uses)
        {
            assert.match(line, /uses: [\w-]+\/[\w-]+@[0-9a-f]{40} # v\d/, line);
        }
    });

    it('refuses a tag that is not v<workspace version>, then installs, builds and tests before anything is published', () =>
    {
        const steps = ['The tag names the workspace version', 'run: npm ci --no-audit --no-fund', 'run: npm run build\n', 'run: npm test --workspaces && npm run test:tools'];
        const positions = steps.map(step => test.indexOf(step));
        assert.ok(positions.every(position => position > 0), JSON.stringify(positions));
        assert.deepEqual([...positions].sort((a, b) => a - b), positions);
        assert.ok(test.includes('if [ "$REF_TYPE" = tag ] && [ "$REF_NAME" != "v$version" ]; then'));
        assert.ok(publish.indexOf('run: npm run build\n') < publish.indexOf('npm run publish:packages -- $order'));
    });

    it('publishes every package in the root build order (the order the build script names them)', () =>
    {
        const root = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as { scripts: Record<string, string>; workspaces: string[] };
        const order = [...root.scripts.build.matchAll(/-w (packages\/[a-z0-9-]+)/g)].map(match => match[1]);
        assert.deepEqual([...order].sort(), [...root.workspaces].sort());
        assert.ok(publish.includes("require('./package.json').scripts.build"));
        assert.ok(publish.includes('matchAll(/-w (packages\\/[a-z0-9-]+)/g)'));
    });

    it('removes the npm credentials whatever the outcome, in both jobs', () =>
    {
        for (const job of [test, publish])
        {
            assert.match(job, /- name: Remove credentials\n {8}if: always\(\)\n {8}run: rm -f ~\/\.npmrc\n/);
        }
    });
});
