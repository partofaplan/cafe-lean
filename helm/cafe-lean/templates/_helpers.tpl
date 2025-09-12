{{- define "cafe-lean.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "cafe-lean.fullname" -}}
{{- if .Release.Name -}}
{{- printf "%s-%s" .Release.Name (include "cafe-lean.name" .) | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- include "cafe-lean.name" . -}}
{{- end -}}
{{- end -}}

{{- define "cafe-lean.labels" -}}
app.kubernetes.io/name: {{ include "cafe-lean.name" . }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
app.kubernetes.io/managed-by: Helm
{{- end -}}

