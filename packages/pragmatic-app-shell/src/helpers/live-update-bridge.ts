import type { NavigationService } from '@pragmatic-tech-ai/mural/framework'

/**
 * Turns a live update (a change notification or an event off the application's socket) into what the operator sees:
 * the active rail service handles it, when it is one of the application's sections (IsSection); any other active
 * service is left alone. The section decides what the update does (reload its current page, so a detail page stays a
 * detail page). An application derives one, naming its section type and what a section does with an event; anything
 * it does first (recording the event) goes in an OnEvent override that then calls the base.
 */
export abstract class LiveUpdateBridge<TEvent, TSection>
{
    protected constructor(private readonly nav: NavigationService)
    {
    }

    public async OnEvent(event: TEvent): Promise<void>
    {
        const section = this.ActiveSection()
        if (section !== undefined)
        {
            await this.Deliver(section, event)
        }
    }

    /** The active rail service when it is one of the application's sections. */
    public ActiveSection(): TSection | undefined
    {
        const active = this.nav.ActiveService
        return this.IsSection(active) ? active : undefined
    }

    protected abstract IsSection(service: unknown): service is TSection

    protected abstract Deliver(section: TSection, event: TEvent): Promise<void>
}
