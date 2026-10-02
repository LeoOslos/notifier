#!/usr/bin/env python3
"""
Castea un archivo de audio (MP3 o WAV) a dispositivos Google Home descubiertos en la red.
Uso: cast_google_home.py <url_audio> [nombre_dispositivo]
  nombre_dispositivo: substring case-insensitive (ej: "Mini"). Omitir = todos.
Volumen (BL-237): si VOZ_VOLUMEN (0-1) está seteada, saca el mute y fija ese volumen antes de
hablar, espera a que termine y devuelve el volumen y el mute que había.
"""
import os
import sys
import time
import pychromecast

FIN_MAX_S = 60   # tope de espera del fin del aviso antes de devolver el volumen


def volumen_aviso() -> float | None:
    v = os.environ.get("VOZ_VOLUMEN", "").strip()
    if not v:
        return None
    v = float(v)
    if not 0 < v <= 1:
        raise ValueError(f"VOZ_VOLUMEN fuera de rango (0-1]: {v}")
    return v


def esperar_fin(mc, max_s: float) -> None:
    time.sleep(1.5)   # recién arrancado, el estado puede no haber pasado a PLAYING
    inicio = time.monotonic()
    while time.monotonic() - inicio < max_s:
        if mc.status.player_state not in ("PLAYING", "BUFFERING"):
            return
        time.sleep(0.5)

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

    volumen = volumen_aviso()
    errors = []
    sonando = []   # (cast, volumen anterior, mute anterior)
    for cast in targets:
        name = cast.cast_info.friendly_name
        try:
            cast.wait(timeout=10)
            if cast.app_id:
                cast.quit_app()
                time.sleep(1)
            previo = (cast.status.volume_level, cast.status.volume_muted)
            if volumen is not None:
                cast.set_volume_muted(False)
                cast.set_volume(volumen)
                print(f"volumen {name}: {previo[0]:.2f}{' mute' if previo[1] else ''} -> {volumen:.2f}", flush=True)
            mc = cast.media_controller
            mc.play_media(audio_url, "audio/wav" if audio_url.endswith(".wav") else "audio/mpeg")
            mc.block_until_active(timeout=15)
            sonando.append((cast, *previo))
            print(f"ok {name}", flush=True)
        except Exception as e:
            errors.append(f"{name}: {e}")
            print(f"error {name}: {e}", flush=True)

    if volumen is not None:
        for cast, vol, mute in sonando:
            name = cast.cast_info.friendly_name
            try:
                esperar_fin(cast.media_controller, FIN_MAX_S)
                cast.set_volume(vol)
                cast.set_volume_muted(mute)
                print(f"volumen {name}: devuelto a {vol:.2f}{' mute' if mute else ''}", flush=True)
            except Exception as e:
                print(f"error {name}: no se pudo devolver el volumen ({e})", flush=True)

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
