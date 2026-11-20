// sign-in.mu - a consumer application's sign-in, compiled against the package entry the way an application's own
// .mu is: the shell's views come from `@pragmatic-tech-ai/pragmatic-app-shell` and render the host's page.

import Pragmatic from "@pragmatic-tech-ai/mural/resources/pragmatic"
import PragmaticDark from "@pragmatic-tech-ai/mural/resources/pragmatic"
import AppShellResources from "@pragmatic-tech-ai/pragmatic-app-shell"
import FixtureSignInHost from "./fixture-sign-in-host.js"

Application [ Theme = Pragmatic, Scheme = PragmaticDark ] {
    .services: {
        FixtureSignInHost
    }

    resources: {
        merge AppShellResources

        ContentControl x:root [ Content = $service(FixtureSignInHost).Page ] { }
    }
}
