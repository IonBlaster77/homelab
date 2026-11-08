# Canonical layout example and build-pipeline smoke test.
#
# Real services live alongside this as services/<name>/, each with its own
# Dockerfile, and are built by the `build-image` WorkflowTemplate in the
# argo-builds namespace (kubernetes/platform/system/argo-workflows/).
#
# Kept deliberately trivial so it always builds: it exists to prove the
# pipeline works, not to do anything useful.
FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
RUN echo "homelab build pipeline smoke test" > /smoke
CMD ["cat", "/smoke"]
