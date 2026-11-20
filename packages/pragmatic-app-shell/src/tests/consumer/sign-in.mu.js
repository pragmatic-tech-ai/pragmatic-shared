import { FixtureSignInHost } from "./fixture-sign-in-host.js";
import { ContentControl } from "@pragmatic-tech-ai/mural/framework/base/content-control.js";
import { Pragmatic, PragmaticDark } from "@pragmatic-tech-ai/mural/resources/pragmatic";
import { Application, NameScope, ServiceBinding, ServiceProvider } from "@pragmatic-tech-ai/mural/runtime";
import { AppShellResources } from "@pragmatic-tech-ai/pragmatic-app-shell";

export const app = (() => {
    const _app0 = new Application();
    _app0.initialize({ theme: Pragmatic, scheme: PragmaticDark });
    _app0.Services.register(ServiceProvider.tokenFor(FixtureSignInHost), (p) => new FixtureSignInHost(p), 'singleton');
    const _rd1 = _app0.Resources;
    for (const [_k, _v] of AppShellResources.Clone().Entries()) _rd1.Set(_k, _v);
    const _contentControl2 = new ContentControl();
    _contentControl2.SetNameScope(new NameScope());
    _contentControl2.set_property_value(ContentControl.ContentKey, ServiceBinding(_contentControl2, ServiceProvider.tokenFor(FixtureSignInHost), "Page"));
    _rd1.Root = _contentControl2;
    return _app0;
})();
