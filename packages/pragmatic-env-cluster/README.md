# @pragmatic-tech-ai/pragmatic-env-cluster

What the environment server (`pragmatic-env-server`) and the environment gateway (`pragmatic-env-gateway`) share,
lifted out of pragmatic-server by the container split (dev-kit A3 Task 4):

- the cluster protocol: `ClusterKeys`, machine headers, machine TLS; the worker routing seam (`IWorkerRouter`,
  `WorkerEndpoint`, `InMemoryWorkerRouter`) and the registration a worker writes and the gateway reads
  (`WorkerRegistration`); `WebSocketAddress`, the address both hosts bind;
- configuration: `ServerConfigLoader`, `ServerConfig` / `GatewayConfig` and their enums (deployment mode and
  provider, audit sink kind, OTLP protocol), the master key reference, paging limits, and the option declarations
  both component descriptors build on (`ServerOptionDeclarations`);
- the host pieces both run: access audit (null, file, SQL sinks), health endpoint, machine principal map, rate limiter
  and its guard;
- observability: the OpenTelemetry setup (`Observability`), request correlation, the drain controller;
- `HostBootstrap`: observability options, audit sink, rate limit and the startup line's shared tokens.

Depends on pragmatic-component, pragmatic-identity, pragmatic-observability, `redis` and the OpenTelemetry SDK;
`@opentelemetry/api` is a peer (one API per process: it keeps the global tracer and meter providers).
