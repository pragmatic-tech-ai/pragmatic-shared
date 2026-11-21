import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { DockerfileTargets } from '../../closure/closure-check.js'
import { ReleaseApp, ReleaseApps } from '../../release/release-tag.js'
import { ContainerProfiles } from '../container-profile.js'
import { ContainerTemplate, ContainerTemplateError, type ContainerTemplateOptions } from '../container-template.js'

/** Reads a rendered Dockerfile by stage: each stage's lines, continuations joined. */
class RenderedDockerfile
{
    private static readonly FromPattern = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i
    private static readonly Continuation = /\\\n/g

    private constructor(private readonly stages: Map<string, { Base: string; Lines: string[] }>)
    {
    }

    public static Parse(text: string): RenderedDockerfile
    {
        const stages = new Map<string, { Base: string; Lines: string[] }>()
        let current: { Base: string; Lines: string[] } | undefined
        for (const raw of text.replace(RenderedDockerfile.Continuation, ' ').split('\n'))
        {
            const line = raw.trim()
            if (line.length === 0 || line.startsWith('#'))
            {
                continue
            }
            const from = RenderedDockerfile.FromPattern.exec(line)
            if (from !== null)
            {
                current = { Base: from[1], Lines: [] }
                stages.set(from[2] ?? String(stages.size), current)
                continue
            }
            current?.Lines.push(line)
        }
        return new RenderedDockerfile(stages)
    }

    public Stage(name: string): string[]
    {
        const stage = this.stages.get(name)
        assert.ok(stage !== undefined, 'no stage ' + name)
        return stage.Lines
    }

    public Base(name: string): string
    {
        const stage = this.stages.get(name)
        assert.ok(stage !== undefined, 'no stage ' + name)
        return stage.Base
    }

    public Names(): string[]
    {
        return [...this.stages.keys()]
    }

    public All(): string[]
    {
        return [...this.stages.values()].flatMap(stage => stage.Lines)
    }
}

class TemplateFixture
{
    public static readonly Placeholder = /\{\{[A-Za-z0-9]+\}\}/
    /** pragmatic-env-server's npm workspaces, as ContainerWorkspaces reads them from its root package.json. */
    public static readonly EnvServerWorkspaces: readonly string[] = ['server', 'packages/pragmatic-connectors-host', 'packages/pragmatic-identity-engine-binding']

    /** The plan's (dev-kit A3, Tasks 6-11) render of each container repository. */
    public static readonly Renders: ReadonlyMap<ReleaseApp, ContainerTemplateOptions> = new Map([
        [ReleaseApp.Postgres, { App: ReleaseApp.Postgres, Entry: 'docker/postgres/Dockerfile', UiDirs: [], ExtraCopies: [] }],
        [ReleaseApp.UiUnpack, { App: ReleaseApp.UiUnpack, Entry: 'src/bin/pragmatic-ui-unpack.ts', UiDirs: [], ExtraCopies: [] }],
        [ReleaseApp.HiveAgent, { App: ReleaseApp.HiveAgent, Entry: 'src/bin/pragmatic-agentd.ts', UiDirs: [], ExtraCopies: [] }],
        [ReleaseApp.EnvGateway, { App: ReleaseApp.EnvGateway, Entry: 'src/bin/pragmatic-gatewayd.ts', UiDirs: [], ExtraCopies: [] }],
        [ReleaseApp.TenantIdp, { App: ReleaseApp.TenantIdp, Entry: 'src/bin/pragmatic-idpd.ts', UiDirs: ['idp-login'], ExtraCopies: ['idp-login/dist'], WritableDirs: ['dist/data'] }],
        [ReleaseApp.EnvServer, { App: ReleaseApp.EnvServer, Entry: 'server/src/bin/pragmatic-serverd.ts', UiDirs: [], ExtraCopies: [], Workspaces: TemplateFixture.EnvServerWorkspaces,
            WritableDirs: ['node_modules/@pragmatic-tech-ai/todl'] }],
        [ReleaseApp.TenantAdmin, { App: ReleaseApp.TenantAdmin, Entry: 'src/bin/pragmatic-tenant-admind.ts', UiDirs: ['tenant-portal'], ExtraCopies: ['environments/sample-apps', 'environments/demo'] }],
        [ReleaseApp.PlatformEdge, { App: ReleaseApp.PlatformEdge, Entry: 'src/bin/pragmatic-platform-edged.ts', UiDirs: [], ExtraCopies: [] }],
        [ReleaseApp.PlatformAdmin, { App: ReleaseApp.PlatformAdmin, Entry: 'src/server.ts', UiDirs: ['portal'], ExtraCopies: ['release-keys', 'environments/demo', 'environments/sample-apps'],
            Assets: [{ From: 'src/templates', To: 'dist/templates' }, { From: 'descriptors', To: 'dist/descriptors' }], WritableDirs: ['dist/data'] }],
    ])

    public static Render(app: ReleaseApp): ReadonlyMap<string, string>
    {
        const options = TemplateFixture.Renders.get(app)
        assert.ok(options !== undefined)
        return ContainerTemplate.Render(options)
    }

    public static File(files: ReadonlyMap<string, string>, path: string): string
    {
        const text = files.get(path)
        assert.ok(text !== undefined, 'not rendered: ' + path)
        return text
    }

    public static Dockerfile(app: ReleaseApp): RenderedDockerfile
    {
        return RenderedDockerfile.Parse(TemplateFixture.File(TemplateFixture.Render(app), 'Dockerfile'))
    }
}

describe('ContainerTemplate', () =>
{
    it('renders a Dockerfile whose component stage refuses a descriptor that does not hash to the label', () =>
    {
        const dockerfile = TemplateFixture.Dockerfile(ReleaseApp.TenantIdp)
        const component = dockerfile.Stage('component')
        assert.ok(component.includes('ARG COMPONENT_DIGEST'))
        const emit = component.find(line => line.includes('pragmatic-component-descriptors'))
        assert.ok(emit !== undefined)
        assert.match(emit, /--components dist\/release-components\.js emit --app "pragmatic-tenant-idp" --digest "\$COMPONENT_DIGEST" --out \/component\/component\.json/)
        // Beside the CLI's own refusal, the stage hashes the very bytes the image will carry and stops on a mismatch.
        assert.ok(component.some(line => line.includes('sha256sum /component/component.json') && line.includes('= "$COMPONENT_DIGEST"') && line.includes('exit 1')))
        // The image carries only that file, labelled with the same digest.
        const image = dockerfile.Stage('pragmatic-tenant-idp')
        assert.ok(image.includes('COPY --from=component /component/component.json /pragmatic/component.json'))
        assert.ok(image.includes('LABEL ai.pragmatic-tech.component.digest=$COMPONENT_DIGEST'))
        assert.ok(image.indexOf('ARG COMPONENT_DIGEST') < image.indexOf('LABEL ai.pragmatic-tech.component.digest=$COMPONENT_DIGEST'))
        // The descriptor set the first bake step exports comes from the same module.
        assert.ok(dockerfile.Stage('component-set').some(line => line.includes('--components dist/release-components.js emit-all --out /components')))
        assert.deepEqual(dockerfile.Stage('components'), ['COPY --from=component-set /components /'])
    })

    it('renders no sibling COPY (packages come from the registry)', () =>
    {
        for (const app of ReleaseApps.All)
        {
            const files = TemplateFixture.Render(app)
            for (const path of ['Dockerfile', 'components.Dockerfile'])
            {
                const text = files.get(path)
                if (text === undefined)
                {
                    continue
                }
                const copies = RenderedDockerfile.Parse(text).All().filter(line => line.startsWith('COPY '))
                assert.ok(copies.length > 0)
                for (const copy of copies)
                {
                    assert.doesNotMatch(copy, /\.\.\//, app + ': ' + copy)
                    assert.doesNotMatch(copy, /\b(pragmatic-shared|todl-runtime|TODL|Mural|pragmatic-protocol|pragmatic-graph|pragmatic-server)\//, app + ': ' + copy)
                    // From the context, only the repository's own manifests and tree; every other COPY reads an earlier stage.
                    const own = copy === 'COPY . .' || copy === 'COPY package.json package-lock.json ./' || /^COPY ([\w@.-]+(?:\/[\w@.-]+)*)\/package\.json \1\/package\.json$/.test(copy)
                    assert.ok(own || /^COPY (--chown=\S+ )?--from=\S+ /.test(copy) || /^COPY --from=\S+ --chown=\S+ /.test(copy), app + ': ' + copy)
                }
            }
        }
    })

    it('the npmrc secret is a build secret mount, never an ARG or ENV', () =>
    {
        for (const app of ReleaseApps.All)
        {
            const files = TemplateFixture.Render(app)
            for (const path of ['Dockerfile', 'components.Dockerfile'])
            {
                const text = files.get(path)
                if (text === undefined)
                {
                    continue
                }
                const lines = RenderedDockerfile.Parse(text).All()
                assert.ok(lines.every(line => !/^(ARG|ENV)\b.*(npmrc|TOKEN|AUTH|PASSWORD|REGISTRY)/i.test(line)), app + ' passes a credential as ARG/ENV')
                // No image build sets an npm setting (no repository installs with legacy-peer-deps).
                assert.deepEqual(lines.filter(line => /^(ARG|ENV)\b.*NPM/i.test(line)), [], app)
                const installs = lines.filter(line => /\bnpm ci\b/.test(line) && !line.includes('--omit=dev'))
                assert.ok(installs.length > 0)
                for (const install of installs)
                {
                    assert.ok(install.startsWith('RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true '), app + ': ' + install)
                }
                assert.ok(!/COPY[^\n]*\.npmrc/.test(text))
            }
            const bake = TemplateFixture.File(files, 'docker-bake.hcl')
            assert.ok(bake.includes('secret     = NPMRC_FILE == "" ? [] : ["id=npmrc,src=${NPMRC_FILE}"]'))
            assert.ok(!bake.includes('args'))
            // The repository's own .npmrc never reaches the build context.
            assert.match(TemplateFixture.File(files, '.dockerignore'), /^\*\*\/\.npmrc$/m)
        }
    })

    it('the .npmrc names the scoped registry and reads its token from NODE_AUTH_TOKEN', () =>
    {
        const npmrc = TemplateFixture.File(TemplateFixture.Render(ReleaseApp.HiveAgent), '.npmrc')
        assert.match(npmrc, /^@pragmatic-tech-ai:registry=https:\/\/npm\.pkg\.github\.com$/m)
        assert.match(npmrc, /^\/\/npm\.pkg\.github\.com\/:_authToken=\$\{NODE_AUTH_TOKEN\}$/m)
        assert.doesNotMatch(npmrc, /gh[pousr]_[A-Za-z0-9]/)
    })

    it('runs stages deps, compile, component, build and the runtime as user 10001 on the pinned node:22-slim', () =>
    {
        const dockerfile = TemplateFixture.Dockerfile(ReleaseApp.EnvGateway)
        assert.deepEqual(dockerfile.Names(), ['deps', 'compile', 'component-set', 'components', 'component', 'build', 'runtime', 'pragmatic-env-gateway'])
        assert.match(dockerfile.Base('deps'), /^node:22@sha256:[0-9a-f]{64}$/)
        assert.match(dockerfile.Base('runtime'), /^node:22-slim@sha256:[0-9a-f]{64}$/)
        assert.equal(dockerfile.Base('pragmatic-env-gateway'), 'runtime')
        assert.ok(dockerfile.Stage('compile').includes('RUN npm run build'))
        assert.ok(dockerfile.Stage('build').some(line => line.startsWith('RUN npm prune --omit=dev')))
        assert.ok(dockerfile.Stage('runtime').some(line => line.includes('--uid 10001 --gid 10001')))
        const image = dockerfile.Stage('pragmatic-env-gateway')
        assert.ok(image.includes('USER 10001'))
        assert.ok(image.includes('EXPOSE 8080'))
        assert.ok(image.some(line => line.startsWith('HEALTHCHECK ') && line.includes("require('node:http')") && line.includes('process.env.PRAGMATIC_PORT||8080')))
        assert.equal(image[image.length - 1], 'ENTRYPOINT ["node", "dist/bin/pragmatic-gatewayd.js"]')
    })

    it('the runtime copies only the app dist, node_modules, package.json, UI dists and the extra copies', () =>
    {
        const image = TemplateFixture.Dockerfile(ReleaseApp.TenantIdp).Stage('pragmatic-tenant-idp')
        const copied = image.filter(line => line.startsWith('COPY --from=build ')).map(line => line.split(' ').at(-1))
        assert.deepEqual(copied, [
            '/workspace/pragmatic-tenant-idp/package.json',
            '/workspace/pragmatic-tenant-idp/node_modules',
            '/workspace/pragmatic-tenant-idp/dist',
            '/workspace/pragmatic-tenant-idp/idp-login/dist',
        ])
        assert.ok(image.filter(line => line.startsWith('COPY ')).every(line => !line.includes('--chown')), 'the app tree is root\'s')
        assert.ok(image.some(line => line.includes('apt-get install') && line.includes('openssl')))
        assert.ok(image.some(line => line.startsWith('HEALTHCHECK ') && line.includes("require('node:https')") && line.includes('rejectUnauthorized:false')))
        // The UI is built (its own lock, the npmrc secret) in the compile stage.
        assert.ok(TemplateFixture.Dockerfile(ReleaseApp.TenantIdp).Stage('compile').some(line => line.includes('cd idp-login && npm ci') && line.includes('npm run build')))
    })

    it('a workspace repository installs every workspace manifest first and ships each workspace, without hand-passed copies', () =>
    {
        const files = TemplateFixture.Render(ReleaseApp.EnvServer)
        const dockerfile = RenderedDockerfile.Parse(TemplateFixture.File(files, 'Dockerfile'))
        const deps = dockerfile.Stage('deps')
        const install = deps.findIndex(line => /\bnpm ci\b/.test(line))
        assert.deepEqual(deps.filter(line => line.startsWith('COPY ')), [
            'COPY package.json package-lock.json ./',
            'COPY server/package.json server/package.json',
            'COPY packages/pragmatic-connectors-host/package.json packages/pragmatic-connectors-host/package.json',
            'COPY packages/pragmatic-identity-engine-binding/package.json packages/pragmatic-identity-engine-binding/package.json',
        ])
        assert.ok(deps.map(line => line.startsWith('COPY ')).lastIndexOf(true) < install)
        assert.equal(dockerfile.Stage('compile')[0], 'COPY . .')
        assert.ok(dockerfile.Stage('build').includes('RUN mkdir -p server/node_modules packages/pragmatic-connectors-host/node_modules packages/pragmatic-identity-engine-binding/node_modules'))
        const image = dockerfile.Stage('pragmatic-env-server')
        assert.equal(image[image.length - 1], 'ENTRYPOINT ["node", "server/dist/bin/pragmatic-serverd.js"]')
        const copied = image.filter(line => line.startsWith('COPY --from=build ')).map(line => line.split(' ').at(-1)?.slice('/workspace/pragmatic-env-server/'.length))
        assert.deepEqual(copied, [
            'package.json', 'node_modules',
            'server/package.json', 'server/node_modules', 'server/dist',
            'packages/pragmatic-connectors-host/package.json', 'packages/pragmatic-connectors-host/node_modules', 'packages/pragmatic-connectors-host/dist',
            'packages/pragmatic-identity-engine-binding/package.json', 'packages/pragmatic-identity-engine-binding/node_modules', 'packages/pragmatic-identity-engine-binding/dist',
        ])
        assert.ok(dockerfile.Stage('component').some(line => line.includes('--components server/dist/release-components.js')))
        const tsconfig = JSON.parse(TemplateFixture.File(files, 'tsconfig.json')) as { compilerOptions: Record<string, unknown>; include: string[] }
        assert.equal(tsconfig.compilerOptions.rootDir, 'server/src')
        assert.equal(tsconfig.compilerOptions.outDir, 'server/dist')
        assert.deepEqual(tsconfig.include, ['server/src'])
    })

    it('a repository without workspaces installs from its root manifests before copying the tree', () =>
    {
        const dockerfile = TemplateFixture.Dockerfile(ReleaseApp.HiveAgent)
        assert.deepEqual(dockerfile.Stage('deps').filter(line => line.startsWith('COPY ')), ['COPY package.json package-lock.json ./'])
        assert.equal(dockerfile.Stage('compile')[0], 'COPY . .')
        assert.equal(dockerfile.Stage('build').some(line => line.startsWith('RUN mkdir -p')), false)
    })

    it('prunes dev dependencies plainly: TODL (0.66.4 on) declares esbuild and typescript as runtime dependencies', () =>
    {
        for (const app of ReleaseApps.NodeApps)
        {
            const build = TemplateFixture.Dockerfile(app).Stage('build').join('\n')
            assert.ok(build.includes('npm prune --omit=dev'), app)
            assert.ok(!build.includes('runtime-dev-stash'), app)
        }
    })

    it('runs the closure check in the compile stage, on the tree the image is cut from', () =>
    {
        for (const app of ReleaseApps.NodeApps)
        {
            assert.ok(TemplateFixture.Dockerfile(app).Stage('compile').includes('RUN ./node_modules/.bin/pragmatic-closure-check'), app)
        }
        assert.ok(!TemplateFixture.File(TemplateFixture.Render(ReleaseApp.Postgres), 'components.Dockerfile').includes('pragmatic-closure-check'))
    })

    it('copies the runtime assets beside the compiled modules after the build', () =>
    {
        const compile = TemplateFixture.Dockerfile(ReleaseApp.PlatformAdmin).Stage('compile')
        const build = compile.indexOf('RUN npm run build')
        const templates = compile.indexOf('RUN rm -rf dist/templates && mkdir -p dist && cp -r src/templates dist/templates')
        const descriptors = compile.indexOf('RUN rm -rf dist/descriptors && mkdir -p dist && cp -r descriptors dist/descriptors')
        assert.ok(build >= 0 && build < templates && templates < descriptors, compile.join('\n'))
        assert.throws(() => ContainerTemplate.Render({ App: ReleaseApp.HiveAgent, Entry: 'src/a.ts', UiDirs: [], ExtraCopies: [], Assets: [{ From: '../x', To: 'dist/x' }] }), ContainerTemplateError)
    })

    it('names the pragmaticClosureCheck options the repository package.json takes', () =>
    {
        const options = (app: ReleaseApp): ContainerTemplateOptions =>
        {
            const found = TemplateFixture.Renders.get(app)
            assert.ok(found !== undefined)
            return found
        }
        assert.deepEqual(ContainerTemplate.ClosureCheckOptions(options(ReleaseApp.HiveAgent)), { Manifest: 'closure.json', Dockerfile: 'Dockerfile', Apps: ['pragmatic-hive-agent'] })
        assert.deepEqual(ContainerTemplate.ClosureCheckOptions(options(ReleaseApp.EnvServer)), {
            Manifest: 'closure.json', Dockerfile: 'Dockerfile', Apps: ['pragmatic-env-server'],
            CompiledRoots: [
                ['server/dist/', 'server/src/'],
                ['packages/pragmatic-connectors-host/dist/', 'packages/pragmatic-connectors-host/src/'],
                ['packages/pragmatic-identity-engine-binding/dist/', 'packages/pragmatic-identity-engine-binding/src/'],
            ],
        })
        assert.equal(ContainerTemplate.ClosureCheckOptions(options(ReleaseApp.Postgres)), undefined)
    })

    it('the platform admin image keeps its pinned provisioning tools and its role', () =>
    {
        const dockerfile = TemplateFixture.Dockerfile(ReleaseApp.PlatformAdmin)
        assert.ok(dockerfile.Stage('platform-admin-tools').some(line => line.includes('sha256sum -c -')))
        const image = dockerfile.Stage('pragmatic-platform-admin')
        for (const tool of ['kubectl', 'kind', 'docker'])
        {
            assert.ok(image.some(line => line.startsWith('COPY --from=platform-admin-tools ') && line.endsWith('/usr/local/bin/' + tool)))
        }
        assert.ok(image.includes('ENV PRAGMATIC_CONTROL_PLANE_ROLE=admin'))
        assert.ok(image.includes('EXPOSE 7000 7001'))
        assert.equal(image[image.length - 1], 'ENTRYPOINT ["node", "dist/server.js"]')
    })

    it('the image stage reads as the closure check reads it', () =>
    {
        const targets = DockerfileTargets.Parse(TemplateFixture.File(TemplateFixture.Render(ReleaseApp.TenantAdmin), 'Dockerfile'))
        assert.deepEqual(targets.Copies('pragmatic-tenant-admin', 'build'), [
            'pragmatic-tenant-admin/package.json',
            'pragmatic-tenant-admin/node_modules',
            'pragmatic-tenant-admin/dist',
            'pragmatic-tenant-admin/tenant-portal/dist',
            'pragmatic-tenant-admin/environments/sample-apps',
            'pragmatic-tenant-admin/environments/demo',
        ])
        assert.deepEqual(targets.Entrypoint('pragmatic-tenant-admin'), ['node', 'dist/bin/pragmatic-tenant-admind.js'])
    })

    it('renders a bake file with the components and app targets, the platforms, the registry and the source label', () =>
    {
        const bake = TemplateFixture.File(TemplateFixture.Render(ReleaseApp.HiveAgent), 'docker-bake.hcl')
        assert.match(bake, /^target "components" \{$/m)
        assert.match(bake, /^target "pragmatic-hive-agent" \{$/m)
        assert.match(bake, /^variable "PLATFORMS" \{\n {2}default = "linux\/amd64"\n\}$/m)
        assert.match(bake, /^variable "REGISTRY" \{\n {2}default = "ghcr.io\/pragmatic-tech-ai"\n\}$/m)
        assert.ok(bake.includes('output    = ["type=local,dest=.components"]'))
        assert.ok(bake.includes('tags      = ["${REGISTRY}/pragmatic-hive-agent:${VERSION}", "${REGISTRY}/pragmatic-hive-agent:git-${GIT_SHA}"]'))
        assert.ok(bake.includes('"org.opencontainers.image.source" = "https://github.com/pragmatic-tech-ai/pragmatic-hive-agent"'))
        assert.ok(bake.includes('target    = "pragmatic-hive-agent"'))
    })

    it('pragmatic-postgres keeps its own Dockerfile: a Node components build and an image target on the entry', () =>
    {
        const files = TemplateFixture.Render(ReleaseApp.Postgres)
        assert.equal(files.has('Dockerfile'), false)
        const components = RenderedDockerfile.Parse(TemplateFixture.File(files, 'components.Dockerfile'))
        assert.deepEqual(components.Names(), ['deps', 'compile', 'component-set', 'components'])
        const bake = TemplateFixture.File(files, 'docker-bake.hcl')
        assert.ok(bake.includes('dockerfile = "components.Dockerfile"'))
        assert.match(bake, /target "pragmatic-postgres" \{\n {2}context {4}= "docker\/postgres"\n {2}dockerfile = "Dockerfile"/)
        assert.ok(bake.includes('components = ".components"'))
        const ci = TemplateFixture.File(files, '.github/workflows/ci.yml')
        assert.ok(ci.includes('node: true'))
        assert.ok(ci.includes('closure-check: false'))
        assert.ok(ci.includes('image-test: true'))
        assert.ok(ci.includes('arm64: true'))
    })

    it('renders the caller workflows on the reusable ones at the toolkit version\'s tag, with the app inputs', () =>
    {
        const files = TemplateFixture.Render(ReleaseApp.EnvServer)
        const ci = TemplateFixture.File(files, '.github/workflows/ci.yml')
        const version = (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version
        assert.equal(ContainerTemplate.WorkflowRef, 'v' + version)
        assert.ok(ci.includes('uses: pragmatic-tech-ai/pragmatic-shared/.github/workflows/container-ci.yml@v' + version + '\n'))
        assert.ok(!ci.includes('@main') && !TemplateFixture.File(files, '.github/workflows/release.yml').includes('@main'))
        assert.ok(ci.includes('app: pragmatic-env-server'))
        assert.ok(ci.includes("helm-chart: 'helm/pragmatic-env-server'"))
        assert.ok(ci.includes('arm64: false'))
        assert.ok(ci.includes('PACKAGES_TOKEN: ${{ secrets.PACKAGES_TOKEN }}'))
        assert.match(ci, /^ {2}push:\n {4}branches: \[main\]\n {2}pull_request:$/m)
        assert.match(ci, /^# Trust: /m)
        assert.ok(ci.includes('closure-check: true'))
        const release = TemplateFixture.File(files, '.github/workflows/release.yml')
        assert.ok(release.includes('uses: pragmatic-tech-ai/pragmatic-shared/.github/workflows/container-release.yml@v' + version + '\n'))
        assert.ok(release.includes("      ui-dirs: ''\n      node: true\n      closure-check: true\n"), 'the checks verify runs, as CI runs them')
        assert.match(release, /tags: \['v\*\.\*\.\*'\]/)
        assert.ok(release.includes('\nconcurrency:\n  group: release-${{ github.ref }}\n  cancel-in-progress: false\n'))
        assert.ok(release.includes('contents: write'))
        assert.ok(release.includes('packages: write'))
        assert.ok(release.includes('version-manifest: server/package.json'))
        assert.ok(release.includes('GHCR_TOKEN: ${{ secrets.GHCR_TOKEN }}'))
        assert.match(release, /^# Trust: /m)
        assert.ok(TemplateFixture.File(TemplateFixture.Render(ReleaseApp.HiveAgent), '.github/workflows/release.yml').includes('version-manifest: package.json'))
        assert.ok(!release.includes('RELEASE_SIGNING_KEY'))
        const idp = TemplateFixture.File(TemplateFixture.Render(ReleaseApp.TenantIdp), '.github/workflows/ci.yml')
        assert.ok(idp.includes("ui-dirs: 'idp-login'"))
        assert.ok(TemplateFixture.File(TemplateFixture.Render(ReleaseApp.TenantIdp), '.github/workflows/release.yml').includes("ui-dirs: 'idp-login'"))
        assert.ok(TemplateFixture.File(TemplateFixture.Render(ReleaseApp.Postgres), '.github/workflows/release.yml').includes('closure-check: false'))
        assert.ok(idp.includes('arm64: true'))
    })

    for (const app of ReleaseApps.All)
    {
        it(`renders ${app}`, () =>
        {
            const files = TemplateFixture.Render(app)
            const expected = ['.npmrc', '.gitattributes', '.gitignore', '.dockerignore', 'tsconfig.json', 'tsconfig.build.json',
                '.github/workflows/ci.yml', '.github/workflows/release.yml', 'docker-bake.hcl',
                app === ReleaseApp.Postgres ? 'components.Dockerfile' : 'Dockerfile']
            assert.deepEqual([...files.keys()].sort(), expected.sort())
            for (const [path, text] of files)
            {
                assert.doesNotMatch(text, TemplateFixture.Placeholder, app + ' ' + path + ' keeps a placeholder')
                assert.ok(!text.includes('\r'), app + ' ' + path + ' has a CR')
                assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), app + ' ' + path + ' ends badly')
                assert.ok(!text.includes('\n\n\n'), app + ' ' + path + ' has a double blank line')
            }
            assert.equal(TemplateFixture.File(files, '.gitattributes').split('\n').filter(line => !line.startsWith('#') && line.length > 0).join('\n'), '* text=auto eol=lf')
            assert.match(TemplateFixture.File(files, '.gitignore'), /^\.components\/$/m)
            JSON.parse(TemplateFixture.File(files, 'tsconfig.json'))
            JSON.parse(TemplateFixture.File(files, 'tsconfig.build.json'))
            assert.ok(TemplateFixture.File(files, '.github/workflows/ci.yml').includes('app: ' + app))
            assert.ok(TemplateFixture.File(files, '.github/workflows/release.yml').includes('app: ' + app))
        })
    }

    it('hands only the WritableDirs to the service user: created and owned by 10001 after the copies, before USER; none, no line', () =>
    {
        const image = TemplateFixture.Dockerfile(ReleaseApp.TenantIdp).Stage('pragmatic-tenant-idp')
        const own = image.filter(line => line.includes('chown'))
        assert.deepEqual(own, ['RUN mkdir -p /workspace/pragmatic-tenant-idp/dist/data && chown 10001:10001 /workspace/pragmatic-tenant-idp/dist/data'])
        const at = image.indexOf(own[0])
        assert.ok(at > image.map(line => line.startsWith('COPY --from=build ')).lastIndexOf(true), 'after the copies')
        assert.ok(at < image.indexOf('USER 10001'))
        assert.ok(!own[0].includes(' -R'), 'what was copied into it stays root\'s')
        const server = TemplateFixture.Dockerfile(ReleaseApp.EnvServer).Stage('pragmatic-env-server').filter(line => line.includes('chown'))
        assert.deepEqual(server, ['RUN mkdir -p /workspace/pragmatic-env-server/node_modules/@pragmatic-tech-ai/todl && chown 10001:10001 /workspace/pragmatic-env-server/node_modules/@pragmatic-tech-ai/todl'])
        for (const app of [ReleaseApp.UiUnpack, ReleaseApp.HiveAgent, ReleaseApp.EnvGateway, ReleaseApp.PlatformEdge, ReleaseApp.TenantAdmin])
        {
            assert.ok(TemplateFixture.Dockerfile(app).All().every(line => !line.includes('chown')), app)
        }
        const two = ContainerTemplate.Render({ App: ReleaseApp.HiveAgent, Entry: 'src/bin/pragmatic-agentd.ts', UiDirs: [], ExtraCopies: [], WritableDirs: ['dist/a', 'cache'] })
        assert.ok(TemplateFixture.File(two, 'Dockerfile').includes('RUN mkdir -p /workspace/pragmatic-hive-agent/dist/a /workspace/pragmatic-hive-agent/cache && chown 10001:10001 /workspace/pragmatic-hive-agent/dist/a /workspace/pragmatic-hive-agent/cache\n'))
        for (const bad of ['/abs', '../up', 'a b', 'a/./b'])
        {
            assert.throws(() => ContainerTemplate.Render({ App: ReleaseApp.HiveAgent, Entry: 'src/bin/pragmatic-agentd.ts', UiDirs: [], ExtraCopies: [], WritableDirs: [bad] }), ContainerTemplateError, bad)
        }
        assert.throws(() => ContainerTemplate.Render({ App: ReleaseApp.Postgres, Entry: 'Dockerfile', UiDirs: [], ExtraCopies: [], WritableDirs: ['data'] }), ContainerTemplateError)
    })

    it('refuses an entry outside src/, an absolute or parent path and a path with spaces', () =>
    {
        const base = { App: ReleaseApp.HiveAgent, Entry: 'src/bin/pragmatic-agentd.ts', UiDirs: [], ExtraCopies: [] }
        for (const options of [
            { ...base, Entry: 'bin/pragmatic-agentd.ts' },
            { ...base, Entry: 'src/bin/pragmatic-agentd.js' },
            { ...base, Entry: '/src/bin/pragmatic-agentd.ts' },
            { ...base, Entry: 'src/../bin/pragmatic-agentd.ts' },
            { ...base, UiDirs: ['../portal'] },
            { ...base, UiDirs: ['my portal'] },
            { ...base, ExtraCopies: ['C:\\keys'] },
            { ...base, ExtraCopies: [''] },
            { ...base, App: 'pragmatic-unknown' as ReleaseApp },
            { ...base, Entry: 'server/src/bin/pragmatic-agentd.ts' },
            { ...base, Entry: 'server/src/bin/pragmatic-agentd.ts', Workspaces: ['packages/other'] },
        ])
        {
            assert.throws(() => ContainerTemplate.Render(options), ContainerTemplateError, JSON.stringify(options))
        }
    })

    it('appends the extra .dockerignore and .gitignore lines (comments allowed) after the common ones, in order', () =>
    {
        const base = { App: ReleaseApp.HiveAgent, Entry: 'src/bin/pragmatic-agentd.ts', UiDirs: [], ExtraCopies: [] }
        const files = ContainerTemplate.Render(base)
        const extra = ['# Local secrets.', '**/*.local.json', 'secrets/', '!secrets/README.md']
        const rendered = ContainerTemplate.Render({ ...base, DockerIgnore: extra, GitIgnore: extra })
        for (const name of ['.dockerignore', '.gitignore'])
        {
            const common = TemplateFixture.File(files, name)
            assert.match(common, /test-results\/?\n$/, name)
            assert.equal(TemplateFixture.File(rendered, name), common + extra.join('\n') + '\n', name)
        }
    })

    it('refuses an extra ignore-file line that is empty or holds a line break', () =>
    {
        const base = { App: ReleaseApp.HiveAgent, Entry: 'src/bin/pragmatic-agentd.ts', UiDirs: [], ExtraCopies: [] }
        for (const line of ['', '   ', 'a\nb', 'a\rb'])
        {
            assert.throws(() => ContainerTemplate.Render({ ...base, DockerIgnore: [line] }), ContainerTemplateError, JSON.stringify(line))
            assert.throws(() => ContainerTemplate.Render({ ...base, GitIgnore: [line] }), ContainerTemplateError, JSON.stringify(line))
        }
    })

    it('renders each repository\'s own ignore lines from its profile: the platform admin console, the env server and the IdP', () =>
    {
        const ignored = (app: ReleaseApp, name: string): string[] => TemplateFixture.File(TemplateFixture.Render(app), name).split('\n')
        assert.ok(ignored(ReleaseApp.PlatformAdmin, '.dockerignore').includes('src/environments/*/master.key'))
        assert.ok(ignored(ReleaseApp.PlatformAdmin, '.gitignore').includes('src/environments/*/provisioned-secrets.json'))
        assert.ok(ignored(ReleaseApp.EnvServer, '.dockerignore').includes('docker/tls'))
        assert.ok(ignored(ReleaseApp.EnvServer, '.gitignore').includes('docker/tls/'))
        assert.ok(ignored(ReleaseApp.TenantIdp, '.gitignore').includes('data/'))
        assert.ok(ignored(ReleaseApp.TenantIdp, '.dockerignore').includes('data'))
        for (const app of [ReleaseApp.HiveAgent, ReleaseApp.UiUnpack, ReleaseApp.EnvGateway])
        {
            assert.match(TemplateFixture.File(TemplateFixture.Render(app), '.gitignore'), /test-results\/\n$/, app)
        }
    })

    it('renders no legacy-peer-deps anywhere: every repository installs the peers its packages declare', () =>
    {
        for (const app of ReleaseApps.All)
        {
            for (const [path, text] of TemplateFixture.Render(app))
            {
                assert.ok(!/legacy-peer-deps|LEGACY_PEER_DEPS/i.test(text), app + ' ' + path)
            }
        }
    })

    it('renders a start smoke refusal pattern where the profile names one (each app whose refusal the default misses)', () =>
    {
        const refusals = new Map<ReleaseApp, string>([
            [ReleaseApp.PlatformAdmin, 'PRAGMATIC_ADMIN_DATABASE_URL_FILE must name'],
            [ReleaseApp.PlatformEdge, 'PRAGMATIC_EDGE_ADMIN_URL must be'],
            [ReleaseApp.EnvGateway, 'are required for the gateway'],
        ])
        for (const app of ReleaseApps.All)
        {
            const ci = TemplateFixture.File(TemplateFixture.Render(app), '.github/workflows/ci.yml')
            const refusal = refusals.get(app)
            const expected = refusal === undefined ? undefined : "\n      start-smoke-refusal: '" + refusal + "'\n"
            assert.equal(ci.includes('start-smoke-refusal:'), expected !== undefined, app)
            if (expected !== undefined)
            {
                assert.ok(ci.includes(expected), app)
            }
        }
    })

    it('runs the image test for tenant-admin, env-server and postgres, and the start smoke everywhere but postgres', () =>
    {
        for (const app of ReleaseApps.All)
        {
            const ci = TemplateFixture.File(TemplateFixture.Render(app), '.github/workflows/ci.yml')
            const imageTest = [ReleaseApp.TenantAdmin, ReleaseApp.EnvServer, ReleaseApp.Postgres].includes(app)
            assert.ok(ci.includes('image-test: ' + imageTest), app)
            assert.equal(ContainerProfiles.Of(app)?.ImageTest, imageTest, app)
            assert.ok(ci.includes('start-smoke: ' + (app !== ReleaseApp.Postgres)), app)
        }
    })

    it('refuses UI dirs and extra copies for pragmatic-postgres and an entry that is not a Dockerfile', () =>
    {
        const base = { App: ReleaseApp.Postgres, Entry: 'docker/postgres/Dockerfile', UiDirs: [], ExtraCopies: [] }
        assert.throws(() => ContainerTemplate.Render({ ...base, UiDirs: ['ui'] }), ContainerTemplateError)
        assert.throws(() => ContainerTemplate.Render({ ...base, ExtraCopies: ['x'] }), ContainerTemplateError)
        assert.throws(() => ContainerTemplate.Render({ ...base, Workspaces: ['x'] }), ContainerTemplateError)
        assert.throws(() => ContainerTemplate.Render({ ...base, Assets: [{ From: 'a', To: 'b' }] }), ContainerTemplateError)
        assert.throws(() => ContainerTemplate.Render({ ...base, Entry: 'src/bin/x.ts' }), ContainerTemplateError)
        const root = ContainerTemplate.Render({ ...base, Entry: 'Dockerfile' })
        assert.match(TemplateFixture.File(root, 'docker-bake.hcl'), /target "pragmatic-postgres" \{\n {2}context {4}= "\."\n {2}dockerfile = "Dockerfile"/)
    })
})
