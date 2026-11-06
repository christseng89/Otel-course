FROM christseng89/web-translator-frontend:v1.3
USER root
COPY dist ./dist
COPY src/public ./dist/public
RUN chown -R node:node /app
USER node
CMD ["node", "dist/index.js"]
