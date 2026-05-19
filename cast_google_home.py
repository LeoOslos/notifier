#!/usr/bin/env python3
"""
Castea un archivo MP3 a todos los dispositivos Google Home descubiertos en la red.
Uso: cast_google_home.py <url_audio>
"""
import sys
import time
import pychromecast

def cast_all(audio_url: str) -> list[str]:
    chromecasts, browser = pychromecast.get_chromecasts()
    if not chromecasts:
        pychromecast.discovery.stop_discovery(browser)
        raise RuntimeError("No se encontraron dispositivos Cast en la red")

    names = [c.cast_info.friendly_name for c in chromecasts]
    errors = []

    for cast in chromecasts:
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

    if errors and len(errors) == len(chromecasts):
        raise RuntimeError("; ".join(errors))

    return names

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Uso: cast_google_home.py <url_audio>", file=sys.stderr)
        sys.exit(1)

    try:
        devices = cast_all(sys.argv[1])
        sys.exit(0)
    except Exception as e:
        print(f"fatal: {e}", file=sys.stderr)
        sys.exit(1)
