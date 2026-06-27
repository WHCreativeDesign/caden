"""
Communication tools — calling and texting.
Stubs wired up to Twilio by default; swap in any provider you prefer.
Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER in .env.
"""

import os
from tools.registry import tool


@tool(
    name="send_text",
    description=(
        "Send an SMS text message to a phone number or a name from your contacts. "
        "Use this when asked to 'text', 'message', or 'SMS' someone."
    ),
    parameters={
        "type": "object",
        "properties": {
            "to": {
                "type": "string",
                "description": "Recipient phone number (e.g. +15551234567) or contact name.",
            },
            "message": {
                "type": "string",
                "description": "The text message body to send.",
            },
        },
        "required": ["to", "message"],
    },
)
async def send_text(to: str, message: str) -> dict:
    # TODO: replace stub with real Twilio call
    # from twilio.rest import Client
    # client = Client(os.getenv("TWILIO_ACCOUNT_SID"), os.getenv("TWILIO_AUTH_TOKEN"))
    # msg = client.messages.create(
    #     body=message,
    #     from_=os.getenv("TWILIO_FROM_NUMBER"),
    #     to=to,
    # )
    # return {"ok": True, "sid": msg.sid}
    return {"ok": True, "message": f"[stub] Text to {to}: \"{message}\""}


@tool(
    name="make_call",
    description=(
        "Initiate a phone call to a number or contact. "
        "Caden will read a message when the call connects, or just ring through."
    ),
    parameters={
        "type": "object",
        "properties": {
            "to": {
                "type": "string",
                "description": "Recipient phone number or contact name.",
            },
            "message": {
                "type": "string",
                "description": "Message to speak when the call connects (optional — if omitted, rings through).",
            },
        },
        "required": ["to"],
    },
)
async def make_call(to: str, message: str | None = None) -> dict:
    # TODO: replace stub with real Twilio call
    # from twilio.rest import Client
    # from twilio.twiml.voice_response import VoiceResponse
    # client = Client(os.getenv("TWILIO_ACCOUNT_SID"), os.getenv("TWILIO_AUTH_TOKEN"))
    # twiml = VoiceResponse()
    # if message:
    #     twiml.say(message)
    # call = client.calls.create(
    #     twiml=str(twiml),
    #     from_=os.getenv("TWILIO_FROM_NUMBER"),
    #     to=to,
    # )
    # return {"ok": True, "sid": call.sid}
    spoken = f" saying: \"{message}\"" if message else ""
    return {"ok": True, "message": f"[stub] Calling {to}{spoken}"}


@tool(
    name="get_contacts",
    description="Look up a person's phone number by name from your contacts list.",
    parameters={
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Contact name to look up.",
            },
        },
        "required": ["name"],
    },
)
async def get_contacts(name: str) -> dict:
    # TODO: integrate with Google Contacts, iCloud, or a local contacts JSON file
    return {
        "ok": False,
        "message": f"[stub] Contact lookup for '{name}' not yet integrated.",
    }
