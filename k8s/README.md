# Moon Bot — Kubernetes deployment

These manifests deploy Moon Bot to a Kubernetes cluster. They match the production architecture described in the project README: a single Socket Mode pod with persistent local data on an `emptyDir` volume (or you can swap it for a `PersistentVolumeClaim`) and an optional Ingress that exposes the artifact bucket HTTP server.

## Quick start

1. Build or pull the image:

   ```bash
   docker build -t moon-bot:latest .
   # or push to a registry reachable by the cluster
   docker tag moon-bot:latest ghcr.io/YOUR_ORG/moon-bot:latest
   docker push ghcr.io/YOUR_ORG/moon-bot:latest
   ```

2. Configure the image in `kustomization.yaml`:

   ```yaml
   images:
     - name: moon-bot
       newName: ghcr.io/YOUR_ORG/moon-bot
       newTag: "1.0.0"
   ```

3. Create the Secret from the example file:

   ```bash
   cp k8s/secret.example.yaml k8s/secret.yaml
   # edit k8s/secret.yaml with real tokens
   ```

4. Apply the manifests:

   ```bash
   kubectl apply -k k8s/
   ```

5. Verify:

   ```bash
   kubectl get pods -n moon-bot
   kubectl logs -n moon-bot -l app.kubernetes.io/name=moon-bot
   kubectl port-forward -n moon-bot svc/moon-bot 3001:3001
   # open http://localhost:3001/health
   ```

## Notes

- The Deployment uses `strategy: Recreate` because Slack Socket Mode allows only one active WebSocket connection per App-Level Token.
- The container runs as non-root with a read-only root filesystem. All mutable runtime state goes to `/app/data` via an `emptyDir` volume.
- If you configure `BUCKET_PUBLIC_URL` to point at the Ingress host, Slack Block Kit artifact buttons will resolve to the cluster.
- To use a PersistentVolumeClaim instead of `emptyDir`, replace the `emptyDir` block in `deployment.yaml` with a `persistentVolumeClaim` volume claim.
- The included `secret.example.yaml` is safe to commit (it contains placeholders). The generated `secret.yaml` is gitignored and should never be committed.
- When running in GitHub-only mode (`GITHUB_ONLY=true`), the webhook server exposes a `/health` endpoint on `GITHUB_WEBHOOK_PORT` (default 3000) for load-balancer or liveness probes.

## GitHub-only bot deployment

The manifests under `k8s/github-only/` deploy a separate, credential-poor pod that replies to `@moon-bot` mentions on GitHub issues and PRs. This pod does not receive Slack credentials or production database credentials; it only needs Cloudflare Workers AI tokens and GitHub credentials.

1. Build or pull the image (same image as the Slack pod):

   ```bash
   docker build -t moon-bot:latest .
   # or push to a registry reachable by the cluster
   docker tag moon-bot:latest ghcr.io/YOUR_ORG/moon-bot:latest
   docker push ghcr.io/YOUR_ORG/moon-bot:latest
   ```

2. Create the GitHub-only secret from the example file:

   ```bash
   cp k8s/github-only/secret.example.yaml k8s/github-only/secret.yaml
   # edit k8s/github-only/secret.yaml with Cloudflare + GitHub credentials only
   ```

3. Apply the GitHub-only manifests:

   ```bash
   kubectl apply -k k8s/github-only/
   ```

4. Configure your GitHub App or repository webhook to POST to the exposed service endpoint, e.g.:

   ```
   http://moon-bot-github-only.moon-bot.svc.cluster.local:3000/
   ```

   From outside the cluster, expose the service through a LoadBalancer, NodePort, or Ingress.

5. Verify:

   ```bash
   kubectl get pods -n moon-bot -l app.kubernetes.io/component=github-bot
   kubectl logs -n moon-bot -l app.kubernetes.io/component=github-bot
   kubectl port-forward -n moon-bot svc/moon-bot-github-only 3000:3000
   # open http://localhost:3000/health
   ```

- The GitHub-only pod uses the same image as the Slack pod. Set `GITHUB_ONLY=true` in `k8s/github-only/secret.yaml` to switch the runtime mode.
