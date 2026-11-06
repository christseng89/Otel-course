# Kubernetes wrapper for the unchanged worker Dockerfile.dev image.
# Docker Compose mounts src at runtime; Kubernetes needs the source in the image.
FROM christseng89/web-translator-worker:v1.3-dev-base

USER root
COPY --chown=app:app handson-labs/app-versions/code/worker/src /app/src
USER app

CMD ["python", "-m", "src.main"]
