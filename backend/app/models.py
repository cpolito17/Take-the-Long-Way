"""API request/response models and the unified place record (spec §4)."""

from typing import Optional

from pydantic import BaseModel, Field

CATEGORIES = [
    "Roadside",
    "Historical",
    "Event",
    "Natural",
    "Art",
    "Weird",
    "Ruins",
    "Community",
    "Other",
]


class Place(BaseModel):
    id: str
    name: str
    description: str = ""
    category: str = "Other"
    source: str  # primary source key (atlas_obscura, hmdb, ...)
    sources: list[str] = []  # all sources that matched during de-dup
    source_url: str = ""
    lat: float
    lng: float
    image_url: Optional[str] = None
    score: float = 0.0
    tags: list[str] = []
    # Per-query fields (spec §4): filled in during a search.
    offset_mi: Optional[float] = None  # straight-line distance from the route
    detour_mi: Optional[float] = None  # approximate added driving distance
    detour_min: Optional[float] = None  # approximate added driving time
    along_mi: Optional[float] = None  # position along the route (for ordering)
    rank: Optional[float] = None  # default ordering: score × source confidence − distance penalty


class Waypoint(BaseModel):
    name: str = ""
    lat: float
    lng: float


class SearchRequest(BaseModel):
    waypoints: list[Waypoint] = Field(min_length=2, max_length=8)
    radius_mi: float = Field(default=25.0, ge=5.0, le=75.0)
    keyword: str = ""
    sources: list[str] = []  # empty = all sources


class RouteInfo(BaseModel):
    coordinates: list[list[float]]  # [lng, lat] pairs
    distance_mi: float
    duration_min: float


class SearchResponse(BaseModel):
    route: RouteInfo
    places: list[Place]
    total_candidates: int  # how many were in the corridor before narrowing


class SelectedStop(BaseModel):
    id: str
    name: str
    lat: float
    lng: float
    category: str = "Other"
    detour_mi: Optional[float] = None
    detour_min: Optional[float] = None


class FinalizeRequest(BaseModel):
    waypoints: list[Waypoint] = Field(min_length=2, max_length=8)
    stops: list[SelectedStop] = Field(min_length=1)


class TripStats(BaseModel):
    distance_mi: float
    duration_min: float


class MapsLink(BaseModel):
    label: str
    url: str


class FinalizeResponse(BaseModel):
    route: RouteInfo  # full route including selected stops
    ordered_stops: list[SelectedStop]
    baseline: TripStats
    trip: TripStats
    added_mi: float
    added_min: float
    maps_links: list[MapsLink]
