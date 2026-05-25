#!/usr/bin/env python3
"""
Notifica via luces LIFX usando la API de Home Assistant.
Uso: cast_lights.py <mode>
  mode: pulse | alert | info (derivado de la prioridad en notifier.js)
"""
import sys
import json
import os
import urllib.request

HA_URL   = os.environ.get('HA_URL',   'http://localhost:8123')
HA_TOKEN = os.environ.get('HA_TOKEN', '')

COLOR_LIGHTS = [
    'light.counter',
    'light.side_table_lamp',
    'light.bedroom_light_2',
    'light.living_room_1',
    'light.piano_lamp',
]

WHITE_LIGHTS = [
    'light.bathroom_lamp',
    'light.shelf_lamp',
]

MODES = {
    'alert': {
        'color': {'mode': 'blink', 'period': 0.3, 'cycles': 3, 'color_name': 'red',  'brightness_pct': 50, 'power_on': False},
        'white': {'mode': 'blink', 'period': 0.3, 'cycles': 3,                        'brightness_pct': 50, 'power_on': False},
    },
    'pulse': {
        'color': {'mode': 'breathe', 'period': 0.35, 'cycles': 1, 'color_name': 'red',  'brightness_pct': 25, 'power_on': False},
        'white': {'mode': 'breathe', 'period': 0.35, 'cycles': 1,                        'brightness_pct': 25, 'power_on': False},
    },
    'info': {
        'color': {'mode': 'breathe', 'period': 1.2, 'cycles': 1, 'color_name': 'blue', 'brightness_pct': 15, 'power_on': False},
        'white': {'mode': 'breathe', 'period': 1.2, 'cycles': 1,                        'brightness_pct': 15, 'power_on': False},
    },
}

def ha_call(data):
    url  = f'{HA_URL}/api/services/lifx/effect_pulse'
    body = json.dumps(data).encode()
    req  = urllib.request.Request(url, data=body, headers={
        'Authorization': f'Bearer {HA_TOKEN}',
        'Content-Type':  'application/json',
    })
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.status

def notify_lights(mode_name):
    mode = MODES[mode_name]
    ha_call({'entity_id': COLOR_LIGHTS, **mode['color']})
    ha_call({'entity_id': WHITE_LIGHTS, **mode['white']})
    print(f'ok mode={mode_name}', flush=True)

def priority_to_mode(priority):
    if priority <= 1: return 'alert'
    if priority <= 4: return 'pulse'
    return 'info'

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Uso: cast_lights.py <mode|priority>', file=sys.stderr)
        sys.exit(1)

    arg = sys.argv[1]
    mode = arg if arg in MODES else priority_to_mode(int(arg))

    try:
        notify_lights(mode)
        sys.exit(0)
    except Exception as e:
        print(f'fatal: {e}', file=sys.stderr)
        sys.exit(1)
