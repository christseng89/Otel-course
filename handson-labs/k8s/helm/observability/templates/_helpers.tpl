{{- define "observability.labels" -}}
app.kubernetes.io/part-of: translation-observability
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
