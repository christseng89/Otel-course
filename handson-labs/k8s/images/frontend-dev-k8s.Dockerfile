# Kubernetes wrapper for the unchanged frontend Dockerfile.dev image.
# Docker Compose mounts src at runtime; Kubernetes needs the source in the image.
FROM christseng89/web-translator-frontend:v1.3-dev-base

USER root
COPY --chown=node:node handson-labs/app-versions/code/frontend/src /app/src
USER node

CMD ["npm", "run", "dev"]
