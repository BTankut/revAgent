#!/bin/sh
set -eu

credential_file=/run/secrets/keycloak_bootstrap_credential
if [ ! -r "$credential_file" ]; then
  echo "keycloak bootstrap credential is unavailable" >&2
  exit 78
fi
bootstrap_value="$(cat "$credential_file")"
if [ "${#bootstrap_value}" -lt 24 ]; then
  echo "keycloak bootstrap credential is too short" >&2
  exit 78
fi
export KC_BOOTSTRAP_ADMIN_PASSWORD="$bootstrap_value"
unset bootstrap_value
exec /opt/keycloak/bin/kc.sh "$@"
