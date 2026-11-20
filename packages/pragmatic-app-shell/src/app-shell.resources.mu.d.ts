// Types for the mural compiler's app-shell.resources.mu.js (generated from app-shell.resources.mu by
// scripts/mu-build.mjs compile; this declaration is hand-written and ships beside it in dist).
import { ResourceDictionary } from '@pragmatic-tech-ai/mural/runtime'

/** The shell's views: merge into an application's resources (`merge AppShellResources`). */
export declare class AppShellResources extends ResourceDictionary
{
    private constructor(gate: symbol)

    /** A fresh dictionary holding the shell's templates and styles. */
    public static Clone(): AppShellResources
}
