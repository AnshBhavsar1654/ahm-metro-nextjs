"""Capture golden fixtures for the chatbot: the real outputs of backend/chatbot's rule layer, retrieval,
tools and prompt assembly, so the TypeScript port in src/domain/chat can be pinned to them.

The model itself is not called. Clocks are pinned to the same IST moment as capture-golden.py
(2026-07-01 10:30) so timetable notes and the "Now in Ahmedabad" stamp never move.

    cd <repo root>
    BACKEND_DIR=<original repo>/backend python scripts/capture-golden-chat.py
"""
import itertools
import json
import os
import sys
from datetime import datetime, timedelta, timezone

# The FastAPI backend these fixtures were captured from (deleted from this repo at cutover): point
# BACKEND_DIR at the original Ahmedabad Metro repository's backend/ folder to recapture.
BACKEND_DIR = os.environ.get("BACKEND_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "Ahmedabad Metro", "backend"))
sys.path.insert(0, BACKEND_DIR)

IST = timezone(timedelta(hours=5, minutes=30))
NOW = datetime(2026, 7, 1, 10, 30, tzinfo=IST)


class FixedDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz else NOW.replace(tzinfo=None)


from metro import timetable  # noqa: E402
from chatbot import assistant, knowledge, rules, tools  # noqa: E402
from metro.network import LINE_NAMES, get_all_stations  # noqa: E402

timetable.datetime = FixedDatetime
assistant.datetime = FixedDatetime

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests", "fixtures", "golden")
os.makedirs(OUT, exist_ok=True)


def dump(name, data):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)


# Messages riders actually send (backend/tests/test_chatbot.py), plus every station in every script and
# a spread of journey phrasings, typos and questions the rules must leave to the model.
HANDWRITTEN = [
    "infocity thi mahatma mandir javanu bhadu ketlu thay?",
    "ઇન્ફોસિટીથી મહાત્મા મંદિર જવાનું ભાડું કેટલું થાય?",
    "ઈન્ફોસિટી થી મહાત્મા મંદિર",
    "इन्फोसिटी से महात्मा मंदिर का किराया",
    "fare from palde to thaltaj gam",
    "to Vastral Gam from Paldi",
    "sector 10a to sector 16",
    "sector 10 to sector 24",
    "gift city",
    "Gift City station",
    "how do I get an NCMC card",
    "what is the refund policy",
    "what is the refund policy for tickets",
    "fare from paldi to thaltej",
    "how to go to gift city from vadaj",
    "paldi vastral",
    "paldi to thaltej",
    "hello",
    "hii",
    "kem cho",
    "good morning",
    "namaste",
    "નમસ્તે",
    "नमस्ते",
    "which is the nearest metro station to me",
    "najik nu metro station kyu che",
    "નજીકનું મેટ્રો સ્ટેશન ક્યાં છે",
    "मेरे पास का मेट्रो स्टेशन",
    "fare from paldi",
    "route from paldi please",
    "paldi",
    "thaltej",
    "what time does the metro start",
    "how long from paldi to vastral gam",
    "paldi station gate timings",
    "can I use my smart card to go to gift city?",
    "how do I reach the airport by metro?",
    "which gate has the lift at kalupur railway station?",
    "can i use my smart card to go from paldi to gift city",
    "fare from paldi to sabarmati",
    "route from aec to motera stadium",
    "fare from vadaj to airport",
    "route from paldi to airport",
    "gift city to shahpur gandhinagar",
    "fare from paldi to shahpur",
    "kya fare hai paldi se vadaj tak",
    "paldi se vadaj kitna kiraya hai",
    "apmc thi gift city kevi rite javu",
    "how many stations between thaltej gam and vastral gam",
    "distance from apmc to motera",
    "which line goes to gnlu",
    "interchange between red and blue line",
    "ticket price old high court to kalupur",
    "modi stadium to kankaria lake",
    "narendra modi stadium",
    "ahmedabad railway station to gift city",
    "sardar patel stadium to vgec",
    "c6 road to gu",
    "commerce six roads to sp stadium fare",
    "dholakua circle to raysan",
    "info city to sachivalaya route",
    "fare from apmc to apmc",
    "paldi to paldi",
    "fare from mars to paldi",
    "the next train from infocity",
    "when is the next train from infocity?",
    "first train from gnlu",
    "last train to apmc",
    "is the metro open now",
    "what is the luggage limit",
    "What is the luggage limit?",
    "how can i obtain daily metro pass as student?",
    "is there a monthly pass",
    "can I take my bicycle on the train",
    "I lost my bag in the train",
    "smart card deposit refund",
    "customer care phone number",
    "can i take my dog",
    "penalty without ticket",
    "xyzzy plugh",
    "and for seniors?",
    "and the refund?",
    "પાલડીથી થલતેજ ભાડું કેટલું?",
    "પાલડીથી થલતેજ કેવી રીતે જવું",
    "पालडी से थलतेज का किराया?",
    "पालडी से थलतेज कैसे जाएं",
    "સેક્ટર 1 થી સેક્ટર 16",
    "सेक्टर 10A से सेक्टर 24 किराया",
    "એરપોર્ટ સુધી ભાડું",
    "गिफ्ट सिटी से शाहपुर (गांधीनगर)",
    "motera stadum to aec",
    "vastrl gam to thaltej",
    "gandhigram to vijaynagr",
    "usmanpura",
    "ranip to sabarmati railway station",
    "rabari colony to apparel park fare please",
    "koteshwar to koteshwar mandir",
    "PDEU to GIFT city how much",
    "how much is the ticket from tapovan circle to koba gam",
    "akshardham to juna sachivalaya and then to mahatma mandir",
]

PHRASINGS = ["{a} to {b}", "fare from {a} to {b}", "route from {a} to {b}", "{a} thi {b} bhadu ketlu", "{a} se {b} kiraya kitna hai"]


def corpus():
    stations = get_all_stations()
    messages = list(HANDWRITTEN)
    for name in stations:
        messages.append(name)
        messages.append(name.lower() + " station")
        for local in rules.NAMES_LOCAL.get(name, ()):
            messages.append(local)
    # Every 7th ordered pair in a rotating phrasing, in Latin and in both local scripts.
    for i, (a, b) in enumerate(itertools.permutations(stations, 2)):
        if i % 7:
            continue
        messages.append(PHRASINGS[(i // 7) % len(PHRASINGS)].format(a=a.lower(), b=b.lower()))
        if a in rules.NAMES_LOCAL and b in rules.NAMES_LOCAL:
            ga, gb = rules.NAMES_LOCAL[a][0], rules.NAMES_LOCAL[b][0]
            ha, hb = rules.NAMES_LOCAL[a][1], rules.NAMES_LOCAL[b][1]
            messages.append(f"{ga}થી {gb} ભાડું કેટલું?" if i % 2 else f"{ga}થી {gb} કેવી રીતે જવું")
            messages.append(f"{ha} से {hb} का किराया" if i % 2 else f"{ha} से {hb} कैसे जाएं")
    return list(dict.fromkeys(messages))


HISTORIES = [
    ([{"role": "user", "text": "fare from paldi?"}, {"role": "bot", "text": "I found Paldi. Which station..."}], "thaltej"),
    ([{"role": "user", "text": "route from paldi please"}, {"role": "bot", "text": "..."}], "vastral gam"),
    ([{"role": "user", "text": "paldi"}, {"role": "bot", "text": "I found Paldi..."}], "thaltej"),
    ([{"role": "user", "text": "પાલડીથી ભાડું?"}, {"role": "bot", "text": "..."}], "થલતેજ"),
    ([{"role": "user", "text": "fare from paldi?"}, {"role": "bot", "text": "..."}], "paldi"),
    ([{"role": "user", "text": "is there a student pass?"}, {"role": "bot", "text": "No."}], "and for seniors?"),
    ([{"role": "user", "text": "hi"}, {"role": "bot", "text": "Hello"}], "and the refund?"),
    ([{"role": "user", "text": "what is the refund policy"}, {"role": "bot", "text": "Unused tickets..."}], "gift city"),
]

KB_QUERIES = [
    "student pass concession", "xyzzy", "refund", "smart card deposit refund", "luggage limit", "bicycle", "lost bag",
    "customer care phone number", "pets dog", "penalty without ticket", "first train last train timings", "parking",
    "NCMC card", "QR ticket whatsapp", "senior citizen discount", "how can i obtain daily metro pass as student?",
    "is there a monthly pass", "frequency blue line", "airport sabarmati not open", "wheelchair lift accessibility",
    "what is the refund policy for tickets", "safety emergency", "fare rules children", "metro timings",
]


def main():
    stations = get_all_stations()
    messages = corpus()

    understanding = {}
    for m in messages:
        found = rules.find_stations(m)
        understanding[m] = {
            "language": rules.detect_language(m),
            "stations": found,
            "intent": rules.detect_intent(m, found),
            "normalised": rules.normalise(m),
            "rules": assistant.answer_with_rules(m, []),
        }
    dump("chat-rules.json", understanding)

    dump(
        "chat-history.json",
        [{"history": h, "message": m, "rules": assistant.answer_with_rules(m, h), "messages": assistant.build_messages(m, h)}
         for h, m in HISTORIES],
    )

    dump("chat-knowledge.json", {q: [s.title for s in knowledge.search(q)] for q in KB_QUERIES + messages[:120]})

    dump(
        "chat-tools.json",
        {
            "station_info": {s: tools.get_station_info.invoke({"station": s}) for s in stations + ["mars", "ઇન્ફોસિટી", "kalupur"]},
            "next_trains": {s: tools.get_next_trains.invoke({"station": s}) for s in stations + ["mars"]},
            "line_stations": {q: tools.get_line_stations.invoke({"line": q})
                              for q in [*LINE_NAMES, "purple", "light blue", "blue line", "red", "pink line", "green"]},
            "journey": {f"{a}|{b}": tools.get_journey.invoke({"from_station": a, "to_station": b})
                        for a, b in [("ઇન્ફોસિટી", "mahatma mandir"), ("Paldi", "Airport"), ("Mars", "Paldi"), ("Paldi", "Mars"),
                                     ("APMC", "Gift City"), ("thaltej", "vastral gam"), ("paldi", "paldi"), ("aec", "motera stadium")]},
            "gate_count": len(tools.gate_data()),
        },
    )

    dump(
        "chat-prompt.json",
        {
            "system": assistant.system_prompt(),
            "turns": {m: assistant.build_messages(m, [])[-1]["content"] for m in messages[:150]},
        },
    )

    print(f"chat golden fixtures: {len(messages)} messages, {len(HISTORIES)} histories, {len(KB_QUERIES)} kb queries")


if __name__ == "__main__":
    main()
