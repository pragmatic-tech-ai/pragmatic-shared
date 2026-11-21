# @pragmatic-tech-ai/pragmatic-observability

Structured logging for the Pragmatic containers (the environment server and gateway, the hive agent): `ILogger`,
`StructuredLogger` (one JSON line per event, with level, message and fields, below a minimum `LogLevel`) and
`NullLogger`. Lifted from pragmatic-server's `src/observability/logger.ts` by the container split (dev-kit A3).

No dependencies: the hive agent and, later, the host agent stay dependency-light.
