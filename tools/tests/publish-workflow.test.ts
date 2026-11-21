import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** .github/workflows/publish.yml, read as text (no YAML parser is installed in this workspace). */
class PublishWorkflow
{
    public static readonly File = path.resolve(__dirname, '..', '..', '.github', 'workflows', 'publish.yml');
    public static readonly PublishSecret = 'PACKAGES_PUBLISH_TOKEN';
    private static readonly SecretReference = /secrets\.([A-Z_]+)/g;
    private static readonly JobHeader = /^ {2}([\w-]+):$/;
    private static readonly JobsHeader = '\njobs:\n';
    private static readonly MainOnly = /^ {4}if: github\.ref_type == 'tag' \|\| github\.ref == 'refs\/heads\/main'\n/m;
    private static readonly ReadOnly = /^ {4}permissions:\n {6}contents: read\n {6}packages: read\n/m;
    private static readonly Install = /npm (ci|install)\b/;

    public static Text(): string
    {
        return fs.readFileSync(PublishWorkflow.File, 'utf8');
    }

    /** The secrets a text names. */
    public static Secrets(text: string): string[]
    {
        return [...new Set([...text.matchAll(PublishWorkflow.SecretReference)].map(match => match[1]))].sort();
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

    public static IsMainOnly(job: string): boolean
    {
        return PublishWorkflow.MainOnly.test(job);
    }

    public static IsReadOnly(job: string): boolean
    {
        return PublishWorkflow.ReadOnly.test(job);
    }

    /** The job's npm install lines. */
    public static Installs(job: string): string[]
    {
        return job.split('\n').filter(line => PublishWorkflow.Install.test(line));
    }
}

describe('publish workflow', () =>
{
    const text = PublishWorkflow.Text();
    const jobs = PublishWorkflow.Jobs(text);
    const pack = jobs.get('pack') ?? '';
    const test = jobs.get('test') ?? '';
    const publish = jobs.get('publish') ?? '';

    it('runs on a pushed v* tag and on demand from main or a tag, one at a time', () =>
    {
        assert.match(text, /^on:\n {2}push:\n {4}tags: \['v\*'\]\n {2}workflow_dispatch:\nconcurrency:\n {2}group: publish\n {2}cancel-in-progress: false\n/m);
        assert.doesNotMatch(text, /^ {2}pull_request:/m);
        assert.doesNotMatch(text, /branches:/);
        assert.deepEqual([...jobs.keys()], ['pack', 'test', 'publish']);
        assert.ok(PublishWorkflow.IsMainOnly(pack));
        assert.match(test, /^ {4}needs: pack\n/m);
        assert.match(publish, /^ {4}needs: \[pack, test\]\n/m);
    });

    it('packs only a commit of main whose packages carry one version, the one a tag on it names', () =>
    {
        assert.match(pack, /fetch-depth: 0\n/);
        assert.ok(pack.includes('if ! git merge-base --is-ancestor "$GITHUB_SHA" origin/main; then'));
        assert.ok(pack.includes("root.workspaces.map(w => require('./' + w + '/package.json').version)"));
        assert.ok(pack.includes('if (versions.length !== 1)'));
        assert.ok(pack.includes('if [ "$REF_TYPE" = tag ] && [ "$REF_NAME" != "v$version" ]; then'));
        assert.ok(pack.includes('if [ "$REF_TYPE" != tag ] && ! grep -qx "v$version" <<< "$(git tag --points-at "$GITHUB_SHA")"; then'));
    });

    it('packs with every install script off and runs no test code there; the tests run in their own job', () =>
    {
        const installs = PublishWorkflow.Installs(pack);
        assert.ok(installs.length >= 4, JSON.stringify(installs));
        for (const line of installs)
        {
            assert.ok(line.includes('--ignore-scripts'), line);
        }
        assert.ok(!pack.includes('npm test'));
        const steps = ['The commit is on main', '(cd pragmatic-shared && npm ci --ignore-scripts --no-audit --no-fund)', '- name: Remove credentials before the build',
            '(cd todl-runtime && npm run build)', 'run: npm run build\n', 'Configure GitHub Packages auth (read, for the pack)',
            'npm run publish:packages -- --pack-into "$RUNNER_TEMP/bundle" $order', 'provenance.json', 'sha256sum -- *.tgz packages.json provenance.json > SHA256SUMS',
            'actions/upload-artifact@'];
        const positions = steps.map(step => pack.indexOf(step));
        assert.ok(positions.every(position => position > 0), JSON.stringify(positions));
        assert.deepEqual([...positions].sort((a, b) => a - b), positions);
        assert.match(pack, /retention-days: 7\n {10}if-no-files-found: error\n {10}overwrite: true\n/);
        assert.ok(test.includes('run: npm test --workspaces && npm run test:tools'));
        assert.ok(test.indexOf('run: npm run typecheck --workspaces && npm run typecheck:tools') > test.indexOf('run: npm run build\n'), 'typechecks the packages, their tests and the tools after the build');
        assert.ok(test.indexOf('run: npm run typecheck --workspaces && npm run typecheck:tools') < test.indexOf('run: npm test --workspaces'));
        assert.ok(!test.includes('publish:packages') && !test.includes('upload-artifact'));
    });

    it('resolves the sibling commits and the Mural version once, and the test job builds those very ones', () =>
    {
        assert.ok(pack.includes('echo "todl=$(git -C TODL rev-parse HEAD)" >> "$GITHUB_OUTPUT"'));
        assert.ok(pack.includes('echo "runtime=$(git -C todl-runtime rev-parse HEAD)" >> "$GITHUB_OUTPUT"'));
        assert.ok(pack.includes('echo "version=$version" >> "$GITHUB_OUTPUT"'));
        assert.match(pack, /^ {6}todl: \$\{\{ steps\.siblings\.outputs\.todl \}\}\n {6}runtime: \$\{\{ steps\.siblings\.outputs\.runtime \}\}\n {6}mural: \$\{\{ steps\.mural\.outputs\.version \}\}\n/m);
        assert.ok(test.includes('TODL_SHA: ${{ needs.pack.outputs.todl }}') && test.includes('RUNTIME_SHA: ${{ needs.pack.outputs.runtime }}'));
        assert.ok(test.includes('git -C "$dir" fetch -q --depth 1 "https://github.com/pragmatic-tech-ai/$repo.git" "$sha"'));
        assert.ok(test.includes('MURAL_VERSION: ${{ needs.pack.outputs.mural }}'));
        assert.ok(!test.includes('npm view @pragmatic-tech-ai/mural version'));
        assert.ok(!test.includes('git clone --depth 1'));
    });

    it('hands the bundle over by artifact id and checksums: the publish refuses any other bundle', () =>
    {
        assert.match(pack, /^ {6}artifact: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}\n {6}sums: \$\{\{ steps\.sums\.outputs\.sha256 \}\}\n/m);
        assert.ok(publish.includes('artifact-ids: ${{ needs.pack.outputs.artifact }}'));
        assert.ok(!/^ {10}name: packages$/m.test(publish), 'never by name');
        assert.ok(publish.includes('SUMS_SHA256: ${{ needs.pack.outputs.sums }}'));
        assert.ok(publish.includes('[ "$(sha256sum SHA256SUMS | cut -d \' \' -f 1)" = "$SUMS_SHA256" ]'));
        assert.ok(publish.includes('sha256sum -c --strict SHA256SUMS'));
        assert.ok(publish.indexOf('sha256sum -c --strict SHA256SUMS') < publish.indexOf('Configure GitHub Packages auth (publish)'));
        assert.ok(publish.includes('if ! [[ "$file" =~ ^[A-Za-z0-9._-]+\\.tgz$ ]] || [[ "$file" == *..* ]]; then'));
    });

    it('reads only GITHUB_TOKEN (read-only) in pack and test; publish holds no GITHUB_TOKEN permission and uses the environment\'s publish token', () =>
    {
        assert.ok(PublishWorkflow.IsReadOnly(pack) && PublishWorkflow.IsReadOnly(test));
        assert.deepEqual(PublishWorkflow.Secrets(pack), ['GITHUB_TOKEN']);
        assert.deepEqual(PublishWorkflow.Secrets(test), ['GITHUB_TOKEN']);
        assert.match(publish, /^ {4}environment: packages\n {4}permissions: \{\}\n {4}steps:/m);
        assert.deepEqual(PublishWorkflow.Secrets(publish), [PublishWorkflow.PublishSecret]);
        assert.doesNotMatch(text, /^permissions:/m);
        assert.ok(!text.includes('RELEASE_SIGNING_KEY'));
        assert.ok(!text.includes('packages: write'));
    });

    it('fails the publish without the environment\'s token, before anything else, and never falls back to GITHUB_TOKEN', () =>
    {
        const guard = publish.indexOf('if [ -z "$PACKAGES_PUBLISH_TOKEN" ]; then');
        assert.ok(guard > 0);
        assert.ok(guard < publish.indexOf('actions/download-artifact@'));
        assert.ok(publish.includes('"$PACKAGES_PUBLISH_TOKEN" > ~/.npmrc'));
    });

    it('publishes the tarballs without a checkout, an install or a build, skipping published versions', () =>
    {
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
        assert.ok(pack.includes("require('./package.json').scripts.build"));
        assert.ok(pack.includes('matchAll(/-w (packages\\/[a-z0-9-]+)/g)'));
    });

    it('pins every action by commit sha', () =>
    {
        const uses = text.split('\n').filter(line => /^\s*(- )?uses: /.test(line));
        assert.ok(uses.length >= 7);
        for (const line of uses)
        {
            assert.match(line, /uses: [\w-]+\/[\w-]+@[0-9a-f]{40} # v\d/, line);
        }
    });

    it('removes the npm credentials whatever the outcome, in every job', () =>
    {
        for (const job of [pack, test, publish])
        {
            assert.match(job, /- name: Remove credentials\n {8}if: always\(\)\n {8}run: rm -f ~\/\.npmrc\n/);
        }
    });
});

/** .github/workflows/ci.yml, read as text: the push and pull request CI of the workspace. */
class CiWorkflow
{
    public static readonly File = path.resolve(__dirname, '..', '..', '.github', 'workflows', 'ci.yml');

    public static Text(): string
    {
        return fs.readFileSync(CiWorkflow.File, 'utf8');
    }
}

describe('ci workflow', () =>
{
    const text = CiWorkflow.Text();
    const jobs = PublishWorkflow.Jobs(text);

    it('grants nothing at the top level; its one job reads contents and packages only', () =>
    {
        assert.match(text, /^permissions: \{\}\njobs:\n/m);
        assert.deepEqual([...jobs.keys()], ['build-test']);
        assert.ok(PublishWorkflow.IsReadOnly(jobs.get('build-test') ?? ''));
        assert.ok(!text.includes('write'));
    });

    it('pins every action by commit sha and keeps no git credentials in the checkout', () =>
    {
        const uses = text.split('\n').filter(line => /^\s*(- )?uses: /.test(line));
        assert.ok(uses.length >= 2);
        for (const line of uses)
        {
            assert.match(line, /uses: [\w-]+\/[\w-]+@[0-9a-f]{40} # v\d/, line);
        }
        const checkouts = text.split('- uses: actions/checkout@').slice(1);
        assert.ok(checkouts.length > 0);
        for (const checkout of checkouts)
        {
            assert.match(checkout, /^[0-9a-f]{40} # v\d\n {8}with:\n(?: {10}.*\n)*? {10}persist-credentials: false\n/);
        }
    });

    it('typechecks every package with its tests after the build, before the tests', () =>
    {
        const job = jobs.get('build-test') ?? '';
        const typecheck = job.indexOf('run: npm run typecheck --workspaces\n');
        assert.ok(typecheck > job.indexOf('run: npm run build\n'));
        assert.ok(typecheck < job.indexOf('run: npm test --workspaces\n'));
        assert.ok(job.includes('run: npm run test:tools && npm run typecheck:tools'));
    });
});
