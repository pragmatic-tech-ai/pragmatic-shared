# @pragmatic-tech-ai/pragmatic-kube

The Kubernetes client layer the platform consoles and the hive agent drive clusters through, lifted from
pragmatic-server by the container split (dev-kit A3):

- `KubeApiClient` over an `IKubeTransport`: `HttpsKubeTransport` with the pod's `InClusterServiceAccount` (token and CA
  re-read per request), `KubeResourceCatalog` (the kinds the platform applies), `KubeApiError`;
- `KubeHttpsTransport` and `KubeServiceAccountDefaults`, the raw HTTPS call the hive agent makes;
- `IKubectl` and `KubectlCli` (the kubectl binary, port-forwarding), `ApiKubectl` (the same seam over the API client,
  with rollout and deletion waits), `IInstallClock` / `SystemInstallClock`, `OrchestratorPolling`.

The manifests the platform renders (`K8sManifestBuilder`, the workloads, the orchestrators, the namespace guard) are the
tenant plane's domain and stay with it.

No dependencies: never todl, todl-runtime or mural (`src/tests/package-deps.test.ts`).
