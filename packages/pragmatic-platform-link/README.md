# @pragmatic-tech-ai/pragmatic-platform-link

The link between the platform edge and the platform admin console, lifted from pragmatic-server by the container split
(dev-kit A3):

- the internal API: `InternalApiRoutes`, `InternalApiClient` (the edge's bearer-authenticated calls),
  `InternalApiLink` (the secret file both sides read, through pragmatic-app-host's `InternalApiCredential`);
- the agent channel: `IAgentChannelBackend` with its request, reply and operation types, `AgentChannelReplies`, and
  `AgentChannelHost`, the HTTP host that serves it;
- desktop discovery: `IDesktopDiscoveryBackend`, `DiscoveryReply`, `DesktopDiscoveryEndpoint`;
- the HTTP helpers both planes share: `PlaneHttp` (with an `IHealthProbe`), the rollout errors, `AuditThrottle`.

Used by the platform edge, the platform admin console and (through the tenant plane's helpers) the tenant admin console.
Depends on `pragmatic-app-host`.
