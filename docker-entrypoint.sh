#!/bin/sh
# Uso: cca web  |  cca ask <contacto> ["pregunta"] [--refresh]  |  cca build-history <contacto> [...]  |  cca user ...
set -e
case "$1" in
  web)
    exec node /app/dist/server.js
    ;;
  ask|build-history|user)
    cmd="$1"
    shift
    exec node "/app/dist/$cmd.js" "$@"
    ;;
  *)
    echo "Uso: cca ask <contacto> [\"pregunta\"] [--refresh]" >&2
    echo "     cca build-history <contacto> [<contacto> ...]" >&2
    echo "     cca user list | add <usuario> [\"Nombre\"] | reset <usuario> | remove <usuario>" >&2
    echo "     cca web   (interfaz web)" >&2
    echo "Contacto: contact_id (123), teléfono con + (+5491122334455) o conversación (conv:18)" >&2
    exit 1
    ;;
esac
