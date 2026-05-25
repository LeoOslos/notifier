#!/usr/bin/env python3
"""
Castea un archivo MP3 a dispositivos Google Home descubiertos en la red.
Uso: cast_google_home.py <url_audio> [nombre_dispositivo]
  nombre_dispositivo: substring case-insensitive (ej: "Mini"). Omitir = todos.
"""
import sys
import time
import pychromecast

def cast_to(audio_url: str, device_filter: str = "") -> list[str]:
    chromecasts, browser = pychromecast.get_chromecasts()
    if not chromecasts:
        pychromecast.discovery.stop_discovery(browser)
        raise RuntimeError("No se encontraron dispositivos Cast en la red")

    if device_filter:
        targets = [c for c in chromecasts if device_filter.lower() in c.cast_info.friendly_name.lower()]
        if not targets:
            names = [c.cast_info.friendly_name for c in chromecasts]
            pychromecast.discovery.stop_discovery(browser)
            raise RuntimeError(f"Ningún dispositivo coincide con '{device_filter}'. Disponibles: {names}")
    else:
        targets = chromecasts

    errors = []
    for cast in targets:
        name = cast.cast_info.friendly_name
        try:
            cast.wait(timeout=10)
            if cast.app_id:
                cast.quit_app()
                time.sleep(1)
            mc = cast.media_controller
            mc.play_media(audio_url, "audio/mpeg")
            mc.block_until_active(timeout=15)
            print(f"ok {name}", flush=True)
        except Exception as e:
            errors.append(f"{name}: {e}")
            print(f"error {name}: {e}", flush=True)

    pychromecast.discovery.stop_discovery(browser)

    if errors and len(errors) == len(targets):
        raise RuntimeError("; ".join(errors))

    return [c.cast_info.friendly_name for c in targets]

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Uso: cast_google_home.py <url_audio> [nombre_dispositivo]", file=sys.stderr)
        sys.exit(1)

    audio_url     = sys.argv[1]
    device_filter = sys.argv[2] if len(sys.argv) > 2 else ""

    try:
        cast_to(audio_url, device_filter)
        sys.exit(0)
    except Exception as e:
        print(f"fatal: {e}", file=sys.stderr)
        sys.exit(1)
