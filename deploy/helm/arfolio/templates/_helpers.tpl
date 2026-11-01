{{- define "arfolio.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "arfolio.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Labels shared by every object. Component selector labels use app.kubernetes.io/name: <fullname>-<component>. */}}
{{- define "arfolio.labels" -}}
app.kubernetes.io/part-of: {{ include "arfolio.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end -}}

{{- define "arfolio.componentLabels" -}}
app.kubernetes.io/name: {{ include "arfolio.fullname" .root }}-{{ .component }}
{{ include "arfolio.labels" .root }}
{{- end -}}

{{- define "arfolio.selectorLabels" -}}
app.kubernetes.io/name: {{ include "arfolio.fullname" .root }}-{{ .component }}
{{- end -}}

{{- define "arfolio.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{/* Fails the render with a clear message when required values are missing. */}}
{{- define "arfolio.validate" -}}
{{- if not .Values.app.url -}}
{{- fail "app.url is required: set it to the public URL of Arfolio, e.g. --set app.url=https://arfolio.example.com" -}}
{{- end -}}
{{- if and (not .Values.postgresql.enabled) (not .Values.externalDatabase.host) -}}
{{- fail "externalDatabase.host is required when postgresql.enabled=false" -}}
{{- end -}}
{{- if and (not .Values.postgresql.enabled) (not .Values.externalDatabase.existingSecret) -}}
{{- fail "externalDatabase.existingSecret is required when postgresql.enabled=false (Secret holding the database owner password, key externalDatabase.ownerPasswordKey)" -}}
{{- end -}}
{{- if and (not .Values.secrets.generate) (not .Values.secrets.existingSecret) -}}
{{- fail "secrets.existingSecret is required when secrets.generate=false" -}}
{{- end -}}
{{- if and .Values.backup.enabled (not .Values.backup.existingSecret) -}}
{{- fail "backup.existingSecret is required when backup.enabled=true (keys: RESTIC_REPOSITORY, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)" -}}
{{- end -}}
{{- end -}}

{{- define "arfolio.secretName" -}}
{{- default (printf "%s-secrets" (include "arfolio.fullname" .)) .Values.secrets.existingSecret -}}
{{- end -}}

{{- define "arfolio.optionalSecretName" -}}
{{- default (printf "%s-optional" (include "arfolio.fullname" .)) .Values.optionalSecret.name -}}
{{- end -}}

{{- define "arfolio.dbHost" -}}
{{- if .Values.postgresql.enabled -}}{{ include "arfolio.fullname" . }}-postgres{{- else -}}{{ .Values.externalDatabase.host }}{{- end -}}
{{- end -}}

{{- define "arfolio.dbPort" -}}
{{- if .Values.postgresql.enabled -}}5432{{- else -}}{{ .Values.externalDatabase.port }}{{- end -}}
{{- end -}}

{{- define "arfolio.dbName" -}}
{{- if .Values.postgresql.enabled -}}pfm{{- else -}}{{ .Values.externalDatabase.database }}{{- end -}}
{{- end -}}

{{- define "arfolio.dbOwnerUser" -}}
{{- if .Values.postgresql.enabled -}}pfm_owner{{- else -}}{{ .Values.externalDatabase.ownerUser }}{{- end -}}
{{- end -}}

{{- define "arfolio.dbAppUser" -}}
{{- if .Values.postgresql.enabled -}}pfm_app{{- else -}}{{ .Values.externalDatabase.appUser }}{{- end -}}
{{- end -}}

{{- define "arfolio.ownerPasswordSecretName" -}}
{{- if .Values.postgresql.enabled -}}{{ include "arfolio.secretName" . }}{{- else -}}{{ .Values.externalDatabase.existingSecret }}{{- end -}}
{{- end -}}

{{- define "arfolio.ownerPasswordSecretKey" -}}
{{- if .Values.postgresql.enabled -}}POSTGRES_PASSWORD{{- else -}}{{ .Values.externalDatabase.ownerPasswordKey }}{{- end -}}
{{- end -}}

{{/* Query string for connection URLs: empty unless an external database sets sslmode. */}}
{{- define "arfolio.dbQuery" -}}
{{- if and (not .Values.postgresql.enabled) .Values.externalDatabase.sslmode -}}?sslmode={{ .Values.externalDatabase.sslmode | urlquery }}{{- end -}}
{{- end -}}

{{/* Env shared by web and worker: DATABASE_URL (as the app role), ENCRYPTION_KEY, TZ and the optional settings. */}}
{{- define "arfolio.commonEnv" -}}
- name: APP_DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "arfolio.secretName" . }}
      key: APP_DB_PASSWORD
- name: DATABASE_URL
  value: postgres://{{ include "arfolio.dbAppUser" . }}:$(APP_DB_PASSWORD)@{{ include "arfolio.dbHost" . }}:{{ include "arfolio.dbPort" . }}/{{ include "arfolio.dbName" . }}{{ include "arfolio.dbQuery" . }}
- name: ENCRYPTION_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "arfolio.secretName" . }}
      key: ENCRYPTION_KEY
- name: TZ
  value: {{ .Values.app.timezone | quote }}
{{- range $key := list "SMTP_URL" "MAIL_FROM" "ANTHROPIC_API_KEY" "ENABLE_BANKING_APP_ID" "ENABLE_BANKING_PRIVATE_KEY" "ENABLE_BANKING_API_URL" "AI_CATEGORISATION_MODEL" "AI_REPORT_MODEL" "AI_VALUATION_MODEL" "MERCHANT_LOGOS" "VAPID_PUBLIC_KEY" "VAPID_PRIVATE_KEY" "VAPID_SUBJECT" "PUSH_ALLOWED_HOSTS" "MCP_ALLOWED_REDIRECT_URIS" }}
- name: {{ $key }}
  valueFrom:
    secretKeyRef:
      name: {{ include "arfolio.optionalSecretName" $ }}
      key: {{ $key }}
      optional: true
{{- end }}
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "arfolio.podCommon" -}}
automountServiceAccountToken: false
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{- define "arfolio.scheduling" -}}
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{- define "arfolio.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}

{{- define "arfolio.podSecurity" -}}
runAsNonRoot: true
runAsUser: 1001
runAsGroup: 1001
seccompProfile:
  type: RuntimeDefault
{{- end -}}
