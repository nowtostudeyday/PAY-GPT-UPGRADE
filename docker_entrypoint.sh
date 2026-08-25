#!/bin/sh

set -eu

if [ "${HEADFUL:-0}" = "1" ]; then
    if [ -z "${VNC_PASSWORD:-}" ]; then
        echo "VNC_PASSWORD is required when HEADFUL=1" >&2
        exit 1
    fi

    export DISPLAY=:99
    Xvfb "$DISPLAY" -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &

    for attempt in $(seq 1 50); do
        if [ -S /tmp/.X11-unix/X99 ]; then
            break
        fi
        sleep 0.1
    done

    if [ ! -S /tmp/.X11-unix/X99 ]; then
        echo "Xvfb did not start" >&2
        exit 1
    fi

    fluxbox >/tmp/fluxbox.log 2>&1 &
    x11vnc -display "$DISPLAY" -rfbport 5900 -forever -shared -passwd "$VNC_PASSWORD" >/tmp/x11vnc.log 2>&1 &
    websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 >/tmp/novnc.log 2>&1 &
    echo "Headful debug is available at http://localhost:${NOVNC_PORT:-6080}/vnc.html"
fi

exec "$@"
