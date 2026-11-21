# @pragmatic-tech-ai/pragmatic-env-cluster

What the environment server (`pragmatic-env-server`) and the environment gateway (`pragmatic-env-gateway`) share,
lifted out of pragmatic-server by the container split (dev-kit A3 Task 4):

- the cluster protocol: `ClusterKeys`, machine headers, machine TLS;
- configuration: `ServerConfigLoader`, `ServerConfig` / `GatewayConfig` and their enums (deployment mode and
  provider, audit sink kind, OTLP protocol), the master key reference, paging and Cypher limits;
- the host pieces both run: access audit (null, file, SQL sinks), health endpoint, machine principal map, rate limiter
  and its guard;
- observability: the OpenTelemetry setup (`Observability`), request correlation, the drain controller;
- `HostBootstrap`: observability options, audit sink, rate limit and the startup line's shared tokens.

Depends on pragmatic-identity, pragmatic-observability and the OpenTelemetry SDK.
