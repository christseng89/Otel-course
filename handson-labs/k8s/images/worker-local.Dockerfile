FROM christseng89/web-translator-worker:v1.3
USER root
COPY src ./src
RUN chown -R app:app /app/src
USER app
CMD ["python", "-m", "src.main"]
