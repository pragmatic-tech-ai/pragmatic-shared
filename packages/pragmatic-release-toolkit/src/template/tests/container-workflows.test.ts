import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ReleaseApp, ReleaseApps } from '../../release/release-tag.js'
import { ContainerTemplate } from '../container-template.js'

/** One job of a workflow, read structurally: its lines, `needs`, `if`, permissions and outputs. */
type WorkflowJob = { Name: string; Lines: string[] }

/**
 * The reusable container workflows of this repository (.github/workflows), read as text and structurally (no YAML
 * parser is installed in this workspace): the top-level blocks by indentation, the jobs, the inputs and their types.
 */
class Workflows
{
    public static readonly Directory = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '.github', 'workflows')
    public static readonly Ci = 'container-ci.yml'
    public static readonly Release = 'container-release.yml'
    public static readonly SigningKey = 'RELEASE_SIGNING_KEY'
    private static readonly RunBlock = /^(\s*)(?:- )?run: \|$/
    private static readonly RunLine = /^\s*(?:- )?run: (?!\|)(.*)$/
    private static readonly JobHeader = /^ {2}([\w-]+):$/
    private static readonly InputHeader = /^ {6}([\w-]+):$/

    public static Read(name: string): string
    {
        return readFileSync(join(Workflows.Directory, name), 'utf8')
    }

    /** Every line of every `run:` script (block or single line). */
    public static Scripts(text: string): string[]
    {
        const lines = text.split('\n')
        const scripts: string[] = []
        for (let i = 0; i < lines.length; i++)
        {
            const single = Workflows.RunLine.exec(lines[i])
            if (single !== null)
            {
                scripts.push(single[1])
                continue
            }
            const block = Workflows.RunBlock.exec(lines[i])
            if (block === null)
            {
                continue
            }
            const indent = block[1].length
            while (i + 1 < lines.length && (lines[i + 1].trim().length === 0 || lines[i + 1].search(/\S/) > indent))
            {
                i++
                scripts.push(lines[i])
            }
        }
        return scripts
    }

    /** The lines of a top-level block (`jobs:`, `on:`), without its header. */
    public static Block(text: string, header: string): string[]
    {
        const lines = text.split('\n')
        const start = lines.indexOf(header + ':')
        assert.ok(start >= 0, header)
        const end = lines.findIndex((line, i) => i > start && /^\S/.test(line))
        return lines.slice(start + 1, end < 0 ? undefined : end)
    }

    public static Jobs(text: string): WorkflowJob[]
    {
        const jobs: WorkflowJob[] = []
        for (const line of Workflows.Block(text, 'jobs'))
        {
            const header = Workflows.JobHeader.exec(line)
            if (header !== null)
            {
                jobs.push({ Name: header[1], Lines: [] })
            }
            else if (line.trim().length > 0)
            {
                jobs.at(-1)?.Lines.push(line)
            }
        }
        return jobs
    }

    /** The workflow_call inputs with their declared types. */
    public static Inputs(text: string): Map<string, string>
    {
        const inputs = new Map<string, string>()
        let current: string | undefined
        let inInputs = false
        for (const line of Workflows.Block(text, 'on'))
        {
            if (line === '    inputs:')
            {
                inInputs = true
                continue
            }
            if (/^ {4}\S/.test(line))
            {
                inInputs = false
            }
            if (!inInputs)
            {
                continue
            }
            const header = Workflows.InputHeader.exec(line)
            if (header !== null)
            {
                current = header[1]
                continue
            }
            const type = /^ {8}type: (\w+)$/.exec(line)
            if (type !== null && current !== undefined)
            {
                inputs.set(current, type[1])
            }
        }
        return inputs
    }

    /** The job's `needs`, as a list. */
    public static Needs(job: WorkflowJob): string[]
    {
        const line = job.Lines.find(l => /^ {4}needs: /.test(l))
        if (line === undefined)
        {
            return []
        }
        const value = line.replace(/^ {4}needs: /, '')
        return value.startsWith('[') ? value.slice(1, -1).split(',').map(name => name.trim()) : [value]
    }
}

describe('container workflows', () =>
{
    it('container-release.yml never references RELEASE_SIGNING_KEY', () =>
    {
        assert.ok(!Workflows.Read(Workflows.Release).includes(Workflows.SigningKey))
        assert.ok(!Workflows.Read(Workflows.Ci).includes(Workflows.SigningKey))
        for (const app of ReleaseApps.All)
        {
            for (const [path, text] of ContainerTemplate.Render({ App: app, Entry: app === ReleaseApp.Postgres ? 'Dockerfile' : 'src/main.ts', UiDirs: [], ExtraCopies: [] }))
            {
                assert.ok(!text.includes(Workflows.SigningKey), app + ' ' + path)
            }
        }
    })

    it('both are called workflows only and pin every action by commit sha', () =>
    {
        for (const name of [Workflows.Ci, Workflows.Release])
        {
            const text = Workflows.Read(name)
            assert.match(text, /^on:\n {2}workflow_call:$/m, name)
            assert.doesNotMatch(text, /^ {2}(push|pull_request|workflow_dispatch):/m, name)
            const uses = text.split('\n').filter(line => /^\s*(- )?uses: /.test(line))
            assert.ok(uses.length > 0)
            for (const line of uses)
            {
                assert.match(line, /uses: [\w-]+\/[\w-]+@[0-9a-f]{40} # v\d/, name + ': ' + line)
            }
        }
    })

    it('no run script interpolates an expression (inputs and secrets reach scripts through env)', () =>
    {
        for (const name of [Workflows.Ci, Workflows.Release])
        {
            const scripts = Workflows.Scripts(Workflows.Read(name))
            assert.ok(scripts.length > 10, name)
            for (const line of scripts)
            {
                assert.ok(!line.includes('${{'), name + ': ' + line)
            }
        }
    })

    it('every job declares its own permissions, needs only jobs that exist, and tests boolean inputs as booleans', () =>
    {
        for (const name of [Workflows.Ci, Workflows.Release])
        {
            const text = Workflows.Read(name)
            assert.doesNotMatch(text, /^permissions:/m, name + ' grants at the top level')
            const jobs = Workflows.Jobs(text)
            const names = jobs.map(job => job.Name)
            const booleans = [...Workflows.Inputs(text)].filter(([, type]) => type === 'boolean').map(([input]) => input)
            assert.ok(booleans.length > 0)
            for (const job of jobs)
            {
                assert.ok(job.Lines.some(line => /^ {4}permissions:/.test(line)), name + ' ' + job.Name)
                for (const need of Workflows.Needs(job))
                {
                    assert.ok(names.includes(need), name + ' ' + job.Name + ' needs ' + need)
                }
                for (const line of job.Lines.filter(l => /^\s*(- )?if: /.test(l)))
                {
                    for (const input of booleans)
                    {
                        assert.doesNotMatch(line, new RegExp('inputs\\.' + input + '\\s*[!=]='), name + ': ' + line)
                    }
                }
            }
        }
    })

    it('container-ci.yml declares its inputs, tolerates a missing PACKAGES_TOKEN, and runs the template steps', () =>
    {
        const ci = Workflows.Read(Workflows.Ci)
        const inputs = Workflows.Inputs(ci)
        assert.deepEqual([...inputs], [['app', 'string'], ['node-test-glob', 'string'], ['ui-dirs', 'string'], ['image-test', 'boolean'],
            ['arm64', 'boolean'], ['helm-chart', 'string'], ['node', 'boolean'], ['closure-check', 'boolean'], ['start-smoke', 'boolean'],
            ['start-smoke-args', 'string'], ['start-smoke-refusal', 'string']])
        assert.match(ci, /^ {6}PACKAGES_TOKEN:\n {8}required: false$/m)
        const jobs = Workflows.Jobs(ci)
        assert.equal(jobs[0].Name, 'gate')
        for (const job of jobs.slice(1))
        {
            assert.ok(Workflows.Needs(job).includes('gate'), job.Name)
            assert.ok(job.Lines.some(line => /^ {4}if: .*needs\.gate\.outputs\.token == 'true'/.test(line)), job.Name)
        }
        for (const step of ['npm ci', 'npm run build', 'npm test', 'npm run typecheck', 'npx --no-install pragmatic-closure-check', 'inputs.node && inputs.closure-check',
            '.components/docker-bake.components.json', 'node_modules/@pragmatic-tech-ai/pragmatic-release-toolkit/scripts/check-component-label.sh',
            'tests/image.test.sh', 'helm lint', 'helm template', 'ubuntu-24.04-arm', 'linux/arm64', 'umask 077', 'if: always()'])
        {
            assert.ok(ci.includes(step), step)
        }
    })

    it('every npx runs only what the repository installed (--no-install: an unscoped name never comes from the public registry)', () =>
    {
        for (const name of [Workflows.Ci, Workflows.Release])
        {
            const npx = Workflows.Scripts(Workflows.Read(name)).filter(line => /\bnpx\b/.test(line))
            for (const line of npx)
            {
                assert.match(line, /\bnpx --no-install /, name + ': ' + line)
            }
        }
    })

    it('container-ci.yml checks the rendered files against the template right after the install', () =>
    {
        const ci = Workflows.Read(Workflows.Ci)
        const build = Workflows.Jobs(ci).find(job => job.Name === 'build-test')?.Lines.join('\n') ?? ''
        const step = build.indexOf('      - name: Rendered files match the template')
        assert.ok(step > build.indexOf('run: npm ci --no-audit --no-fund'), 'after the install')
        assert.ok(step < build.indexOf('      - name: Build'), 'before the build')
        const text = build.slice(step, build.indexOf('      - name: Build'))
        assert.ok(text.includes("require('./package.json').pragmaticContainerTemplate"))
        assert.ok(text.includes('npx --no-install pragmatic-container-template check'))
    })

    it('container-ci.yml typechecks the repository after the build, skipping only a repository without a typecheck script', () =>
    {
        const ci = Workflows.Read(Workflows.Ci)
        const build = ci.indexOf('        run: npm run build\n')
        const typecheck = ci.indexOf('      - name: Typecheck\n')
        assert.ok(build > 0 && typecheck > build, 'after the build')
        assert.ok(typecheck < ci.indexOf('      - name: Test\n'), 'before the tests')
        const step = ci.slice(typecheck, ci.indexOf('      - name: Test\n'))
        assert.match(step, /if: inputs\.node\n/)
        assert.ok(step.includes("require('./package.json').scripts?.typecheck"))
        assert.ok(step.includes('npm run typecheck'))
    })

    it('container-ci.yml starts every baked image once when asked (opt-in): the toolkit script, after the bake and the label check', () =>
    {
        const ci = Workflows.Read(Workflows.Ci)
        const jobs = new Map(Workflows.Jobs(ci).map(job => [job.Name, job.Lines.join('\n')]))
        for (const [job, label] of [['build-test', 'Component descriptor in the image matches its label\n'], ['image-arm64', 'Component descriptor in the image matches its label (arm64)\n']])
        {
            const body = jobs.get(job) ?? ''
            const start = body.indexOf('      - name: Start smoke')
            assert.ok(start > body.indexOf(label), job + ': after the bake and the label check')
            const step = body.slice(start, body.indexOf('      - name: Image test', start))
            assert.match(step, /if: inputs\.start-smoke\n/, job)
            assert.match(step, /SMOKE_ARGS: \$\{\{ inputs\.start-smoke-args \}\}/, job)
            assert.match(step, /SMOKE_REFUSAL: \$\{\{ inputs\.start-smoke-refusal \}\}/, job)
            assert.ok(step.includes('run: bash node_modules/@pragmatic-tech-ai/pragmatic-release-toolkit/scripts/start-smoke.sh "$IMAGE"'), job)
        }
        const inputs = Workflows.Block(ci, 'on').join('\n')
        assert.match(inputs, / {6}start-smoke:\n {8}description: .*\n {8}type: boolean\n {8}default: false\n/, 'callers rendered before it keep passing')
        assert.match(inputs, / {6}start-smoke-refusal:\n {8}description: .*\n {8}type: string\n {8}default: 'is required\|required environment\|must be set'\n/)
    })

    it('start-smoke.sh fails on a module error or an end without a refusal (exit 0 included), passes a running image, and always removes it', () =>
    {
        const script = readFileSync(join(Workflows.Directory, '..', '..', 'packages', 'pragmatic-release-toolkit', 'scripts', 'start-smoke.sh'), 'utf8')
        assert.ok(script.startsWith('#!/usr/bin/env bash\n'))
        assert.ok(script.includes('set -euo pipefail'))
        assert.ok(script.includes('read -r -a ARGS <<< "${SMOKE_ARGS:-}"'), 'split on blanks, never globbed')
        assert.ok(script.includes('docker run -d --name "$NAME" "${ARGS[@]}" "$IMAGE"'), 'no configuration but the extra args')
        assert.ok(script.includes('SECONDS_TO_WAIT="${SMOKE_SECONDS:-20}"'))
        for (const marker of ['ERR_MODULE_NOT_FOUND', 'Cannot find module', 'Cannot find package', 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_UNSUPPORTED_DIR_IMPORT',
            'ERR_UNKNOWN_FILE_EXTENSION', 'ERR_REQUIRE_ESM'])
        {
            assert.ok(script.includes(marker), marker)
        }
        assert.ok(script.includes('if grep -Eq "$MODULE_ERROR" <<< "$logs"; then'), 'here-strings, never a pipe into grep -q (SIGPIPE)')
        assert.ok(script.includes('if [ "$running" = false ] && { [ "$code" = 0 ] || ! grep -Eiq "$REFUSAL" <<< "$logs"; }; then'), 'an exit 0 fails too')
        assert.doesNotMatch(script, /\| *grep/)
        assert.ok(script.includes('trap cleanup EXIT') && script.includes('docker rm -f "$NAME"'), 'stopped and removed whatever the outcome')
        assert.ok(!script.includes('\r'))
    })

    it('every bake names its bake file, also the first (components) step', () =>
    {
        for (const name of [Workflows.Ci, Workflows.Release])
        {
            const bakes = Workflows.Scripts(Workflows.Read(name)).filter(line => line.includes('docker buildx bake'))
            assert.ok(bakes.length >= 2, name)
            for (const line of bakes)
            {
                assert.ok(line.includes('docker buildx bake -f docker-bake.hcl '), name + ': ' + line)
            }
            assert.ok(bakes.some(line => line.trimEnd().endsWith(' components')), name)
        }
    })

    it('every npm step reads the written npmrc (UI installs included) and the file is removed always', () =>
    {
        for (const name of [Workflows.Ci, Workflows.Release])
        {
            const text = Workflows.Read(name)
            for (const job of Workflows.Jobs(text).filter(j => j.Lines.some(line => line.includes('npm ci'))))
            {
                const body = job.Lines.join('\n')
                const written = body.indexOf('echo "NPM_CONFIG_USERCONFIG=$RUNNER_TEMP/npmrc" >> "$GITHUB_ENV"')
                assert.ok(written > 0, name + ' ' + job.Name)
                assert.ok(written < body.indexOf('npm ci'), name + ' ' + job.Name)
                assert.ok(body.lastIndexOf('umask 077', written) > 0, name + ' ' + job.Name)
                assert.match(body, /if: always\(\)\n {8}run: rm -f "\$RUNNER_TEMP\/npmrc"/, name + ' ' + job.Name)
            }
        }
    })

    it('container-release.yml verifies, pushes by digest, joins the arches, outputs the digest and attaches the descriptor', () =>
    {
        const release = Workflows.Read(Workflows.Release)
        assert.deepEqual([...Workflows.Inputs(release)], [['app', 'string'], ['arm64', 'boolean'], ['version-manifest', 'string'], ['node-test-glob', 'string'], ['ui-dirs', 'string'], ['node', 'boolean'], ['closure-check', 'boolean']])
        assert.match(release, /^ {6}PACKAGES_TOKEN:\n {8}required: true\n {6}GHCR_TOKEN:\n {8}required: false$/m)
        // The digest output: workflow output <- publish job output <- the join step's GITHUB_OUTPUT.
        assert.match(release, /^ {4}outputs:\n {6}digest:\n {8}description: .*\n {8}value: \$\{\{ jobs\.publish\.outputs\.digest \}\}$/m)
        const jobs = new Map(Workflows.Jobs(release).map(job => [job.Name, job]))
        assert.deepEqual([...jobs.keys()], ['check', 'verify', 'images', 'publish'])
        const publish = jobs.get('publish')?.Lines.join('\n') ?? ''
        assert.match(publish, /^ {4}outputs:\n {6}digest: \$\{\{ steps\.join\.outputs\.digest \}\}$/m)
        assert.match(publish, /id: join\n[\s\S]*echo "digest=\$digest" >> "\$GITHUB_OUTPUT"/)
        assert.match(publish, /^ {4}permissions:\n {6}contents: write\n {6}packages: write$/m)
        // The matrix: the check job's arches output, one native runner per arch.
        const check = jobs.get('check')?.Lines.join('\n') ?? ''
        assert.match(check, /^ {4}permissions:\n {6}contents: read$/m)
        assert.match(check, /arches: \$\{\{ steps\.version\.outputs\.arches \}\}/)
        assert.ok(check.includes('jq -r .version "$MANIFEST"'))
        const images = jobs.get('images')?.Lines.join('\n') ?? ''
        assert.deepEqual(Workflows.Needs(jobs.get('images') ?? { Name: '', Lines: [] }), ['check', 'verify'])
        assert.match(images, /arch: \$\{\{ fromJSON\(needs\.check\.outputs\.arches\) \}\}/)
        assert.match(images, /^ {4}permissions:\n {6}contents: read\n {6}packages: write$/m)
        for (const job of [images, publish])
        {
            assert.match(job, /password: \$\{\{ secrets\.GHCR_TOKEN \|\| github\.token \}\}/)
        }
        assert.ok((jobs.get('verify')?.Lines.join('\n') ?? '').includes('npm run build'))
        for (const step of ['push-by-digest=true', 'docker buildx imagetools create', ':git-', 'ghcr.io/pragmatic-tech-ai/', 'component.json', 'digest.txt',
            'gh release create', 'gh release upload', 'ubuntu-24.04-arm', 'umask 077', 'if: always()'])
        {
            assert.ok(release.includes(step), step)
        }
    })

    it('container-ci.yml fails a repository without render arguments: every container repository keeps them', () =>
    {
        const ci = Workflows.Read(Workflows.Ci)
        const start = ci.indexOf('      - name: Rendered files match the template')
        const step = ci.slice(start, ci.indexOf('      - name: Build', start))
        assert.ok(step.includes("if ! node -e \"process.exit(require('./package.json').pragmaticContainerTemplate ? 0 : 1)\"; then"))
        assert.match(step, /echo '::error::package\.json has no pragmaticContainerTemplate[^']*'\n {12}exit 1\n/)
        assert.ok(!step.includes('::warning::'))
    })

    it('container-release.yml releases only a commit on main, checked before anything else', () =>
    {
        const release = Workflows.Read(Workflows.Release)
        const check = Workflows.Jobs(release).find(job => job.Name === 'check')?.Lines.join('\n') ?? ''
        assert.match(check, /with:\n {10}fetch-depth: 0\n {10}persist-credentials: false\n/)
        const ancestry = check.indexOf('if ! git merge-base --is-ancestor "$GITHUB_SHA" origin/main; then')
        assert.ok(ancestry > 0)
        assert.ok(ancestry < check.indexOf('      - name: Resolve the version from the tag'))
        assert.ok(check.includes('echo "::error::$GITHUB_SHA is not on main: only a commit of main is released"'))
    })

    it('container-release.yml verify runs container-ci\'s checks up to its image bake, step for step, with the same inputs', () =>
    {
        const ci = Workflows.Read(Workflows.Ci)
        const release = Workflows.Read(Workflows.Release)
        const build = Workflows.Jobs(ci).find(job => job.Name === 'build-test')?.Lines.join('\n') ?? ''
        const verify = Workflows.Jobs(release).find(job => job.Name === 'verify')?.Lines.join('\n') ?? ''
        const ciSteps = build.slice(build.indexOf('    steps:'), build.indexOf('      # Two steps: the descriptor'))
        const verifySteps = verify.slice(verify.indexOf('    steps:'), verify.indexOf('      - name: Remove credentials'))
        assert.ok(ciSteps.length > 1000)
        assert.equal(verifySteps, ciSteps)
        for (const step of ['Rendered files match the template', 'Build', 'Typecheck', 'Test', 'UI unit tests', 'Image closure check'])
        {
            assert.ok(verifySteps.includes('      - name: ' + step + '\n'), step)
        }
        assert.match(verify, /- name: Remove credentials\n {8}if: always\(\)\n {8}run: rm -f "\$RUNNER_TEMP\/npmrc"/)
        const ciInputs = Workflows.Inputs(ci)
        const releaseInputs = Workflows.Inputs(release)
        for (const input of ['node-test-glob', 'ui-dirs', 'node', 'closure-check'])
        {
            assert.equal(releaseInputs.get(input), ciInputs.get(input), input)
            const defaultOf = (text: string): string | undefined => new RegExp('^ {6}' + input + ':\\n {8}description: .*\\n {8}type: \\w+\\n {8}default: (.*)$', 'm').exec(text)?.[1]
            assert.equal(defaultOf(release), defaultOf(ci), input + ' default')
        }
    })

    it('container-release.yml never moves a released tag: :<version> and :git-<sha> must already name the digest the create writes', () =>
    {
        const release = Workflows.Read(Workflows.Release)
        const publish = Workflows.Jobs(release).find(job => job.Name === 'publish')?.Lines.join('\n') ?? ''
        const dryRun = publish.indexOf('docker buildx imagetools create --dry-run -t "$image:$VERSION" "${sources[@]}" > "$RUNNER_TEMP/planned.json"')
        assert.ok(dryRun > 0)
        assert.ok(publish.includes('planned="sha256:$(head -c -1 "$RUNNER_TEMP/planned.json" | sha256sum | cut -d \' \' -f 1)"'), 'the printed bytes less the newline')
        const loop = publish.indexOf('for tag in "$VERSION" "git-$GITHUB_SHA"; do')
        assert.ok(loop > dryRun)
        assert.ok(publish.includes('if [ "$existing" != "$planned" ]; then'))
        assert.ok(publish.includes('a released tag is never moved (cut a new version)'))
        assert.ok(publish.includes("elif grep -qi 'not found' \"$RUNNER_TEMP/inspect.err\"; then"), 'only a missing tag is created; any other read failure stops')
        const creates = publish.split('\n').filter(line => line.includes('docker buildx imagetools create') && !line.includes('--dry-run'))
        assert.deepEqual(creates.map(line => line.trim()), ['docker buildx imagetools create "${missing[@]}" "${sources[@]}"'])
        assert.ok(publish.indexOf(creates[0]) > loop)
    })

    it('container-release.yml outputs the digest :<version> resolves to after the create (for a single arch, not the arch\'s push digest)', () =>
    {
        const release = Workflows.Read(Workflows.Release)
        const publish = Workflows.Jobs(release).find(job => job.Name === 'publish')?.Lines.join('\n') ?? ''
        const create = publish.indexOf('docker buildx imagetools create "${missing[@]}" "${sources[@]}"')
        const readBack = publish.indexOf('digest="$(docker buildx imagetools inspect "$image:$VERSION" --format \'{{json .Manifest}}\' | jq -r .digest)"')
        assert.ok(readBack > create && create > 0)
        assert.ok(publish.indexOf('if [ "$digest" != "$planned" ]; then') > readBack)
        assert.ok(publish.indexOf('echo "digest=$digest" >> "$GITHUB_OUTPUT"') > readBack)
        assert.equal(publish.split('\n').filter(line => line.includes('>> "$GITHUB_OUTPUT"')).length, 1)
        assert.ok(publish.indexOf('printf \'%s\\n\' "$digest" > "$RUNNER_TEMP/assets/digest.txt"') > readBack)
        assert.ok(release.includes('# new index. So for a single arch the release digest is not the arch\'s push digest but whatever :<version> resolves to\n# after the create, read back from the registry'))
    })

    it('container-release.yml reads the pushed image\'s component label back and compares it with the descriptor, before attaching it', () =>
    {
        const release = Workflows.Read(Workflows.Release)
        const publish = Workflows.Jobs(release).find(job => job.Name === 'publish')?.Lines.join('\n') ?? ''
        const step = publish.indexOf('      - name: The pushed image\'s component label is the descriptor\'s digest')
        assert.ok(step > publish.indexOf('      - name: Join the arches under the version tags'))
        assert.ok(step < publish.indexOf('      - name: Attach component.json and digest.txt to the GitHub release'))
        const text = publish.slice(step, publish.indexOf('      - name: Attach'))
        assert.ok(text.includes('DIGEST: ${{ steps.join.outputs.digest }}'))
        assert.ok(text.includes('expected="sha256:$(sha256sum "$RUNNER_TEMP/assets/component.json" | cut -d \' \' -f 1)"'))
        assert.ok(text.includes('docker buildx imagetools inspect "$image@$DIGEST" --format \'{{json .Image}}\''))
        assert.ok(text.includes('.config.Labels["ai.pragmatic-tech.component.digest"] // "none"'))
        assert.ok(text.includes('if [ "$label" != "$expected" ]; then'))
        assert.ok(text.includes('if [ "$(wc -l <<< "$labels")" != "$arches" ]; then'), 'one labelled config per arch')
    })

    it('container-release.yml never replaces a release asset: an attached one must be byte-identical', () =>
    {
        const release = Workflows.Read(Workflows.Release)
        assert.ok(!release.includes('--clobber'))
        const publish = Workflows.Jobs(release).find(job => job.Name === 'publish')?.Lines.join('\n') ?? ''
        assert.ok(publish.includes('attached="$(gh release view "$TAG" --repo "$GITHUB_REPOSITORY" --json assets --jq \'.assets[].name\')"'))
        assert.ok(publish.includes('if ! cmp -s "$asset" "$RUNNER_TEMP/attached/$asset"; then'))
        assert.ok(publish.includes('a released asset is never replaced'))
        assert.ok(publish.includes('gh release upload "$TAG" "$asset" --repo "$GITHUB_REPOSITORY"'))
    })

    it('check-component-label.sh names an image without a descriptor (file=missing) instead of stopping bare', () =>
    {
        const script = readFileSync(join(Workflows.Directory, '..', '..', 'packages', 'pragmatic-release-toolkit', 'scripts', 'check-component-label.sh'), 'utf8')
        assert.ok(script.includes('set -euo pipefail'))
        assert.ok(script.includes('if ! docker run --rm --network none --entrypoint cat "$image" "$descriptor_path" > "$descriptor"; then'))
        assert.ok(script.includes('content="$(sha256sum "$descriptor" | cut -d \' \' -f 1)"'), 'the bytes as stored, trailing newline included')
        assert.ok(script.includes("trap 'rm -f \"$descriptor\"' EXIT"))
        assert.ok(script.includes('echo "MISMATCH $image label=${label:-none} file=missing" >&2'))
        assert.ok(script.includes('if ! label="$(docker image inspect --format'), 'an image that cannot be inspected is named too')
        assert.ok(!script.includes('\r'))
    })
})
