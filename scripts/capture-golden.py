"""Capture golden fixtures: the real outputs of the backend's domain functions.

Runs against backend/data (the live Python implementation, frozen at cutover) so the
TypeScript port in src/domain/metro can be pinned to it (tests/golden). Route payload
assembly mirrors backend/app.py's GET /api/route handler field-for-field; departures and
next-trains are pinned to a fixed IST moment (2026-07-01 10:30) so the fixtures are stable.

    cd <repo root>
    python scripts/capture-golden.py
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

from metro.locations import get_nearby_stations_data, get_stations_with_coordinates  # noqa: E402
from metro.network import (  # noqa: E402
    calculate_route_details,
    get_all_stations,
    get_fare,
    get_line_geometries,
    is_operational,
    resolve_station,
    station_status,
)
from metro.timetable import (  # noqa: E402
    departures,
    journey_minutes,
    journey_trains,
    stay_on_train,
    through_service,
)

# A fixed moment so departures()/journey_trains() outputs never move (a Wednesday, metro running).
IST = timezone(timedelta(hours=5, minutes=30))
NOW = datetime(2026, 7, 1, 10, 30, tzinfo=IST)

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests", "fixtures", "golden")
os.makedirs(OUT, exist_ok=True)


def dump(name, data):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)


def route_payload(source, destination):
    """Exactly the dict backend/app.py's get_route() returns (minus the HTTP wrapper)."""
    result = calculate_route_details(source, destination)
    if result["error"]:
        return {"error": result["error"]}
    return {
        "route": result["route"],
        "interchanges": result["interchanges"],
        "distance": result["distance"],
        "instructions": result["instructions"],
        "geometry": result["geometry"],
        "legs": [{**leg, "stay_on_train": stay} for leg, stay in zip(result["legs"], [*stay_on_train(result["legs"]), False])],
        "duration_minutes": journey_minutes(result["legs"]),
        "through_service": through_service(result["legs"]),
        "next_trains": journey_trains(result["legs"], now=NOW),
        "not_operational": result["not_operational"],
        "alternatives": [
            {
                "route": alt["route"],
                "legs": alt["legs"],
                "interchanges": alt["interchanges"],
                "distance": alt["distance"],
                "duration_minutes": journey_minutes(alt["legs"]),
            }
            for alt in result.get("alternatives", [])
        ],
    }


def fares_from(source):
    """Exactly backend/app.py's fares_from()."""
    resolved = resolve_station(source)
    if not resolved:
        return {"error": "Unknown station"}
    if not is_operational(resolved):
        return []
    return [{"station": s, "fare": get_fare(resolved, s)} for s in get_all_stations() if s != resolved]


def station_departures(station):
    """Exactly backend/app.py's station_departures()."""
    name = resolve_station(station)
    if not name:
        return {"error": "Unknown station"}
    if not is_operational(name):
        return {"station": name, "status": station_status(name), "directions": [], "source": None}
    return departures(name, now=NOW) or {"station": name, "status": "operational", "directions": [], "source": None}


def main():
    stations = get_all_stations()

    dump("stations.json", stations)
    dump("lines.json", get_line_geometries())
    dump("station-coordinates.json", get_stations_with_coordinates())

    # Every ordered pair of distinct stations, in the app's payload shape.
    routes = {}
    for src in stations:
        for dst in stations:
            if src != dst:
                routes[f"{src}|{dst}"] = route_payload(src, dst)
    dump("routes.json", routes)

    # Error shapes a rider can trigger from the UI.
    dump(
        "route-errors.json",
        {
            "unknown-source": route_payload("Nope Station", "APMC"),
            "unknown-destination": route_payload("APMC", "Nope Station"),
            "same-station": route_payload("APMC", "APMC"),
        },
    )

    dump("fares.json", {s: fares_from(s) for s in stations})

    dump("departures.json", {s: station_departures(s) for s in stations})

    # Nearby stations from the live routing services for one fixed city-centre point
    # (external data: tests compare structure, not exact distances).
    dump("nearby.json", get_nearby_stations_data(23.0225, 72.5714))

    # Google Maps URLs that carry their coordinates in the link itself: pure parsing, stable.
    dump(
        "google-maps-coords.json",
        {
            "at-zoom": "https://www.google.com/maps/place/Riverfront/@23.0225,72.5714,15z",
            "query": "https://www.google.com/maps/search/?api=1&query=23.0225,72.5714",
            "ll": "https://maps.google.com/?ll=23.0225,72.5714",
            "3d-4d": "https://www.google.com/maps/@?api=1&map_action=pano&heading=-45&pitch=-20&!3d23.0225!4d72.5714",
        },
    )

    print(
        f"golden fixtures: {len(stations)} stations, {len(routes)} route payloads (pairs), "
        f"{len(stations)} fares-from tables, {len(stations)} departure tables"
    )


if __name__ == "__main__":
    main()
