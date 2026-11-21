# @pragmatic-tech-ai/pragmatic-app-shell

The client shell of a Mural application (the platform admin console, the tenant admin console, the personal cabinet,
the clients ledger), speaking the routes of `@pragmatic-tech-ai/pragmatic-app-host`. Design:
`dev-kit/docs/superpowers/specs/2026-11-20-a4-app-host-design.md` (Ledger, Part 2).

## Pieces

- `AppShellConfig`: what the application says about itself, injected through constructors: product name, sign-in
  methods (`SignInMethod.Oidc`, `SignInMethod.Password` for break-glass), the mount prefix (`ApiBasePath`), the host
  routes (defaults are the host's: `/api/session`, `/api/logout`, `/api/login`, `/auth/oidc/begin`,
  `/api/ws-ticket`; the own-password change path is the application's, and so is the signed-out page,
  `Paths.SignedOut`), the password floor, the claim names and `HideUnofferedActions` (an OIDC-only application hides
  Change password instead of showing it greyed).
- `ApiClientBase`: the JSON client every application client derives from. Own-origin paths only, same-origin
  credentials, a JSON body on every mutation; non-2xx throws `ApiError`; every 401 / 403 is raised on
  `Unauthorized` / `Forbidden` first.
- `AppSessionClient`: session probe, password and OIDC sign-in, logout, WebSocket tickets, own-password change.
  An application's client extends it, so all of its requests feed the same signals. `Logout` answers where the
  browser goes next: an OIDC host's `{ redirect }` (the IdP's end-session endpoint, or a signed-out page), undefined
  for a 204 (password-only host); an answer that is neither an http(s) URL nor an own-origin path leads to
  `Paths.SignedOut` (undefined without one).
- `AppSession`: subject plus multi-valued claims; email and roles from the configured claims.
- `AppSessionService`: the signed-in session in the shell: expiry on 401 (one reload back to sign-in), the access
  notice on 403, Log out, Change password, expiry suspended while the own password changes. Log out reloads, or,
  when the host answers a destination, assigns the page there (the `IPageNavigator` given to `Initialize`, default
  the reloader when it navigates too, as `BrowserPage` does), so an OIDC sign-out ends the IdP's SSO session too
  instead of signing the person straight back in.
- `SignInPageViewModel` + `SignInHostService`, `ShellDialogViewModel`, `ChangePasswordDialogViewModel`,
  `OneTimeSecretPageViewModel`, `PendingSecret` / `PendingWork`, `AppShellBoot` + `BrowserShellMount`. Pass the
  page query to `AppShellBoot` (`window.location.search`): back from a failed sign-in (`?sign_in=failed`, the host's
  `OidcLoginEndpoint` `SignInFailedPath`) it shows the sign-in page saying so instead of redirecting again, and Try
  again begins a new sign-in. Pass the page path too (`window.location.pathname`): at `Paths.SignedOut` (under the
  base path; its path must match the host's `PostLogoutRedirectUri`, where the IdP returns a signed-out browser; a
  trailing slash, a query and a fragment are ignored) it mounts the sign-in page without probing the session or
  redirecting to the IdP (`BootOutcome.SignedOut`; with `?sign_in=failed` it says the sign-in failed instead).
- App-level helpers: `OptionViewModel` (a ComboBox choice), `NameConfirmDialogViewModel` (type the name to confirm;
  optional reason; the application overrides `IsPermitted`), `LiveUpdateBridge` (an application derives one naming
  its section type and what a section does with a live update).
- `AppShellResources`: the compiled views (`app-shell.resources.mu`). Merge into the application's resources:

```
import AppShellResources from "@pragmatic-tech-ai/pragmatic-app-shell"

Application [ ... ] {
    resources: {
        merge AppShellResources
        ...
    }
}
```

## Building

`@pragmatic-tech-ai/mural` and `@pragmatic-tech-ai/todl-runtime` are peers (one copy of each in the application).
`npm run build` compiles the `.mu` views with the mural CLI (the generated `.mu.js` is committed), runs `tsc`, and
copies each `.mu.js` and its hand-written `.mu.d.ts` into `dist` beside the view models it imports. `npm test`
runs against the committed `.mu.js` and the built `dist` (the consumer fixture imports the package entry), so build
first; it does not recompile, which would leave `dist` older than `src` for the publish tool.
