# Canonical layout example and build-pipeline smoke test.
#
# Real services live alongside this as services/<name>/, each with its own
# Dockerfile, and are built by the `build-image` WorkflowTemplate in the
# argo-builds namespace (kubernetes/platform/system/argo-workflows/).
#
# Kept deliberately trivial so it always builds: it exists to prove the
# pipeline works, not to do anything useful.
FROM alpine:3.24@sha256:3f4d6b32e26703c6082839234f43769d5046b3ac7c910033911d1e71d8cd630a
RUN echo "homelab build pipeline smoke test" > /smoke
CMD ["cat", "/smoke"]
