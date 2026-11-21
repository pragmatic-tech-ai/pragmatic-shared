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
    private static readonly JobsHeader = '\njobs:\n';

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
        const lines = text.slice(text.indexOf(PublishWorkflow.JobsHeader) + PublishWorkflow.JobsHeader.length).split('\n');
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

    it('runs on a pushed v* tag and on demand from main or a tag, one at a time', () =>
    {
        assert.match(text, /^on:\n {2}push:\n {4}tags: \['v\*'\]\n {2}workflow_dispatch:\nconcurrency:\n {2}group: publish\n {2}cancel-in-progress: false\n/m);
        assert.doesNotMatch(text, /^ {2}pull_request:/m);
        assert.doesNotMatch(text, /branches:/);
        assert.match(test, /^ {4}if: github\.ref_type == 'tag' \|\| github\.ref == 'refs\/heads\/main'\n/m);
        assert.match(publish, /^ {4}needs: test\n/m);
    });

    it('publishes only a commit of main: the full history is checked out and the commit must be an ancestor of origin/main', () =>
    {
        assert.match(test, /fetch-depth: 0\n/);
        assert.ok(test.includes('if ! git merge-base --is-ancestor "$GITHUB_SHA" origin/main; then'));
        assert.ok(test.indexOf('The commit is on main') < test.indexOf('run: npm ci --no-audit --no-fund'));
    });

    it('requires every package to carry one version, the one the tag names', () =>
    {
        assert.ok(test.includes("root.workspaces.map(w => require('./' + w + '/package.json').version)"));
        assert.ok(test.includes('if (versions.length !== 1)'));
        assert.ok(test.includes('if [ "$REF_TYPE" = tag ] && [ "$REF_NAME" != "v$version" ]; then'));
    });

    it('tests with a read-only token; only the publish job, in environment packages, holds packages: write', () =>
    {
        assert.deepEqual([...jobs.keys()], ['test', 'publish']);
        assert.match(test, /^ {4}permissions:\n {6}contents: read\n {6}packages: read\n/m);
        assert.match(publish, /^ {4}environment: packages\n {4}permissions:\n {6}packages: write\n {4}steps:/m);
        assert.doesNotMatch(text, /^permissions:/m);
        assert.deepEqual(PublishWorkflow.Secrets(text), ['GITHUB_TOKEN']);
        assert.ok(!text.includes('RELEASE_SIGNING_KEY'));
    });

    it('packs and tests in the test job; the publish job checks nothing out, installs and builds nothing, and publishes the tarballs', () =>
    {
        const steps = ['The commit is on main', 'run: npm ci --no-audit --no-fund', 'run: npm run build\n', 'run: npm test --workspaces && npm run test:tools',
            'npm run publish:packages -- --pack-into "$RUNNER_TEMP/bundle" $order', 'provenance.json', 'actions/upload-artifact@'];
        const positions = steps.map(step => test.indexOf(step));
        assert.ok(positions.every(position => position > 0), JSON.stringify(positions));
        assert.deepEqual([...positions].sort((a, b) => a - b), positions);
        assert.ok(!publish.includes('actions/checkout'));
        assert.doesNotMatch(publish, /npm (ci|install|run|test)\b/);
        assert.ok(publish.includes('actions/download-artifact@'));
        assert.ok(publish.includes('npm publish "./$file" --ignore-scripts --registry https://npm.pkg.github.com'));
        assert.ok(publish.indexOf('npm view "$name@$version" version') < publish.indexOf('npm publish'), 'a published version is skipped');
    });

    it('packs every package in the root build order (the order the build script names them)', () =>
    {
        const root = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as { scripts: Record<string, string>; workspaces: string[] };
        const order = [...root.scripts.build.matchAll(/-w (packages\/[a-z0-9-]+)/g)].map(match => match[1]);
        assert.deepEqual([...order].sort(), [...root.workspaces].sort());
        assert.ok(test.includes("require('./package.json').scripts.build"));
        assert.ok(test.includes('matchAll(/-w (packages\\/[a-z0-9-]+)/g)'));
    });

    it('pins every action by commit sha', () =>
    {
        const uses = text.split('\n').filter(line => /^\s*(- )?uses: /.test(line));
        assert.ok(uses.length >= 5);
        for (const line of uses)
        {
            assert.match(line, /uses: [\w-]+\/[\w-]+@[0-9a-f]{40} # v\d/, line);
        }
    });

    it('removes the npm credentials whatever the outcome, in both jobs', () =>
    {
        for (const job of [test, publish])
        {
            assert.match(job, /- name: Remove credentials\n {8}if: always\(\)\n {8}run: rm -f ~\/\.npmrc\n/);
        }
    });
});
