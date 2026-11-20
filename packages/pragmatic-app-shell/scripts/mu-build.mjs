// The package's .mu steps. `compile` turns every src/**/*.mu into its sibling .mu.js through the mural CLI (the
// generated files are committed, as in the portals). `copy` puts each generated .mu.js and its hand-written .mu.d.ts
// into dist beside the compiled view models they import, so a consumer imports views and view models from one place.
// The CLI is found on Node's own module search path (mural's `exports` do not expose its package.json, and the
// workspace hoists the file: link to the root node_modules) and realpath'd: the CLI only runs when its own resolved
// URL equals process.argv[1].
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, globSync, mkdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

class MuBuild
{
    static PackageName = '@pragmatic-tech-ai/mural'
    static CliRelativePath = join('dist', 'tooling', 'cli.js')
    static SourceGlob = 'src/**/*.mu'
    static GeneratedGlobs = ['src/**/*.mu.js', 'src/**/*.mu.d.ts']
    static TestsSegment = 'tests'
    static SourceDir = 'src'
    static OutputDir = 'dist'
    static CompileVerb = 'compile'
    static CopyVerb = 'copy'
    static LogPrefix = '[mu-build]'
    static MissingCli = 'cannot find the mural CLI on the module search path'
    static NoSources = 'no .mu files found under src/'
    static Usage = 'usage: node scripts/mu-build.mjs compile|copy'

    static Run(verb)
    {
        process.chdir(join(dirname(fileURLToPath(import.meta.url)), '..'))
        if (verb === MuBuild.CompileVerb)
        {
            MuBuild.Compile()
            return
        }
        if (verb === MuBuild.CopyVerb)
        {
            MuBuild.Copy()
            return
        }
        console.error(MuBuild.LogPrefix, MuBuild.Usage)
        process.exit(2)
    }

    static Compile()
    {
        const files = globSync(MuBuild.SourceGlob)
        if (files.length === 0)
        {
            console.warn(MuBuild.LogPrefix, MuBuild.NoSources)
            return
        }
        execFileSync(process.execPath, [MuBuild.ResolveCli(), MuBuild.CompileVerb, ...files], { stdio: 'inherit' })
    }

    static Copy()
    {
        for (const glob of MuBuild.GeneratedGlobs)
        {
            for (const file of globSync(glob))
            {
                // Test fixtures (a consumer application compiled against the package) never ship.
                if (file.split(sep).includes(MuBuild.TestsSegment))
                {
                    continue
                }
                const target = join(MuBuild.OutputDir, relative(MuBuild.SourceDir, file))
                mkdirSync(dirname(target), { recursive: true })
                copyFileSync(file, target)
            }
        }
    }

    static ResolveCli()
    {
        const lookup = createRequire(import.meta.url).resolve.paths(MuBuild.PackageName) ?? []
        for (const base of lookup)
        {
            const candidate = join(base, MuBuild.PackageName, MuBuild.CliRelativePath)
            if (existsSync(candidate))
            {
                return realpathSync(candidate)
            }
        }
        console.error(MuBuild.LogPrefix, MuBuild.MissingCli)
        process.exit(1)
    }
}

// The class constants are fixed: freezing the class makes them read-only.
Object.freeze(MuBuild)
MuBuild.Run(process.argv[2])
