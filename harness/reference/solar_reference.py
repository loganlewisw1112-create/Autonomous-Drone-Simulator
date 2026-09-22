"""Independent solar-position reference for Gate 2.1.

Deliberately NOT the algorithm in src/scene3d/sun.ts (NOAA/Meeus, equation-of-time + hour angle).
This is the PSA algorithm (Blanco-Muriel, Alarcon-Padilla, Lopez-Moratalla, Lara-Coira, 2001):
ecliptic coordinates -> right ascension/declination -> sidereal time -> local horizontal, with a
parallax term. Different formulae, different constants, different language. Geometric (no
refraction): at the elevations tabulated here refraction is <= 0.17 deg, inside the 0.5 deg gate.

Run:  python harness/reference/solar_reference.py      (prints the table hardcoded in gate-2.mjs)
"""
import math
from datetime import datetime, timezone

def psa(dt: datetime, lat_deg: float, lng_deg: float):
    hour = dt.hour + dt.minute / 60 + dt.second / 3600
    # Julian day by the Fliegel-Van Flandern integer formula (independent of the epoch-ms route).
    a = int((dt.month - 14) / 12)  # C-style truncation toward zero; Python's // floors and is WRONG here
    jdn = (1461 * (dt.year + 4800 + a)) // 4 + (367 * (dt.month - 2 - 12 * a)) // 12 - (3 * ((dt.year + 4900 + a) // 100)) // 4 + dt.day - 32075
    d = jdn - 0.5 + hour / 24 - 2451545.0
    omega = 2.1429 - 0.0010394594 * d
    mean_long = 4.8950630 + 0.017202791698 * d
    mean_anom = 6.2400600 + 0.0172019699 * d
    ecl_long = mean_long + 0.03341607 * math.sin(mean_anom) + 0.00034894 * math.sin(2 * mean_anom) - 0.0001134 - 0.0000203 * math.sin(omega)
    obliquity = 0.4090928 - 6.2140e-9 * d + 0.0000396 * math.cos(omega)
    ra = math.atan2(math.cos(obliquity) * math.sin(ecl_long), math.cos(ecl_long)) % (2 * math.pi)
    decl = math.asin(math.sin(obliquity) * math.sin(ecl_long))
    gmst = 6.6974243242 + 0.0657098283 * d + hour
    lmst = math.radians(gmst * 15 + lng_deg)
    ha = lmst - ra
    lat = math.radians(lat_deg)
    zenith = math.acos(math.cos(lat) * math.cos(ha) * math.cos(decl) + math.sin(decl) * math.sin(lat))
    az = math.atan2(-math.sin(ha), math.tan(decl) * math.cos(lat) - math.sin(lat) * math.cos(ha)) % (2 * math.pi)
    zenith += (6371.01 / 149597890.0) * math.sin(zenith)  # parallax
    return math.degrees(az), 90 - math.degrees(zenith)

AOI = (40.0072, -121.0085)  # train_wildfire_flank DEM centroid
CASES = [
    ("dawn",  datetime(2021, 8, 5, 13, 40, tzinfo=timezone.utc)),
    ("noon",  datetime(2021, 8, 5, 20, 10, tzinfo=timezone.utc)),
    ("dusk",  datetime(2021, 8, 6, 2, 40, tzinfo=timezone.utc)),
    ("night", datetime(2021, 8, 6, 9, 0, tzinfo=timezone.utc)),
]
for tag, when in CASES:
    az, el = psa(when, *AOI)
    print(f"{{ tag: '{tag}', utc: '{when.strftime('%Y-%m-%dT%H:%M:%SZ')}', lat: {AOI[0]}, lng: {AOI[1]}, azimuthDeg: {az:.3f}, elevationDeg: {el:.3f} }},")
# Cross-check of THIS script against a published value: NREL SPA (Reda & Andreas 2004) worked example,
# 2003-10-17 12:30:30 local (UTC-7), 39.742476 N 105.1786 W -> topocentric zenith 50.11162, azimuth 194.34024.
az, el = psa(datetime(2003, 10, 17, 19, 30, 30, tzinfo=timezone.utc), 39.742476, -105.1786)
print(f"# NREL SPA example: published az 194.340 el 39.888 (incl. ~0.02 refraction) | PSA az {az:.3f} el {el:.3f}")
