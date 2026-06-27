"""
Home automation tools.
Replace the stub bodies with real integrations as you build them
(e.g. Home Assistant REST API, python-kasa for TP-Link, rpi-gpio, etc.).
"""

from tools.registry import tool


@tool(
    name="control_light",
    description=(
        "Turn a smart light or group of lights on or off, or set their brightness "
        "and colour. Use room names like 'living room', 'bedroom', 'kitchen', "
        "or device names like 'desk lamp'."
    ),
    parameters={
        "type": "object",
        "properties": {
            "target": {
                "type": "string",
                "description": "Room name or device name to control.",
            },
            "action": {
                "type": "string",
                "enum": ["on", "off", "toggle"],
                "description": "What to do with the light.",
            },
            "brightness": {
                "type": "integer",
                "minimum": 0,
                "maximum": 100,
                "description": "Brightness percentage (optional).",
            },
            "color": {
                "type": "string",
                "description": "Colour name or hex code, e.g. 'warm white' or '#FF8C00' (optional).",
            },
        },
        "required": ["target", "action"],
    },
)
async def control_light(
    target: str,
    action: str,
    brightness: int | None = None,
    color: str | None = None,
) -> dict:
    # TODO: integrate with Home Assistant / python-kasa / etc.
    detail = f"brightness={brightness}%" if brightness is not None else ""
    if color:
        detail += f" color={color}"
    return {
        "ok": True,
        "message": f"Light '{target}' turned {action}. {detail}".strip(),
    }


@tool(
    name="set_thermostat",
    description="Set the home thermostat to a target temperature.",
    parameters={
        "type": "object",
        "properties": {
            "temperature": {
                "type": "number",
                "description": "Target temperature in Fahrenheit.",
            },
            "mode": {
                "type": "string",
                "enum": ["heat", "cool", "auto", "off"],
                "description": "Thermostat mode.",
            },
        },
        "required": ["temperature"],
    },
)
async def set_thermostat(temperature: float, mode: str = "auto") -> dict:
    # TODO: integrate with Nest / Ecobee / Home Assistant climate entity
    return {
        "ok": True,
        "message": f"Thermostat set to {temperature}°F in {mode} mode.",
    }


@tool(
    name="lock_door",
    description="Lock or unlock a smart door lock.",
    parameters={
        "type": "object",
        "properties": {
            "door": {
                "type": "string",
                "description": "Which door, e.g. 'front door', 'garage'.",
            },
            "action": {
                "type": "string",
                "enum": ["lock", "unlock"],
            },
        },
        "required": ["door", "action"],
    },
)
async def lock_door(door: str, action: str) -> dict:
    # TODO: integrate with August / Schlage / Home Assistant lock entity
    return {"ok": True, "message": f"{door.title()} {action}ed."}


@tool(
    name="get_home_status",
    description=(
        "Get a summary of the current home state — lights on, temperature, "
        "door lock status, and any active alerts."
    ),
    parameters={"type": "object", "properties": {}, "required": []},
)
async def get_home_status() -> dict:
    # TODO: query Home Assistant /api/states or equivalent
    return {
        "lights": {"living_room": "off", "bedroom": "off", "kitchen": "on"},
        "thermostat": {"temperature_f": 71, "mode": "auto", "setpoint_f": 70},
        "doors": {"front_door": "locked", "garage": "locked"},
        "alerts": [],
    }
