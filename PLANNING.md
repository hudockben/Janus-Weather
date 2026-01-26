# Janus Forecast Model - Project Plan

A weather application for Western Pennsylvania (Indiana County focus) using NOAA and PennDOT data sources.

---

## Project Overview

**Name:** Janus Forecast Model
**Target Area:** Western Pennsylvania, primarily Indiana County
**Architecture:** Simple frontend + backend (user-managed)

---

## Data Sources

### 1. NOAA National Weather Service API (Primary Weather Data)

**Base URL:** `https://api.weather.gov`

**Key Endpoints:**
| Endpoint | Purpose |
|----------|---------|
| `/points/{lat},{lon}` | Get forecast office & grid coordinates for a location |
| `/gridpoints/{office}/{x},{y}/forecast` | 7-day forecast (12-hour periods) |
| `/gridpoints/{office}/{x},{y}/forecast/hourly` | Hourly forecast for 7 days |
| `/alerts/active?area=PA` | Active weather alerts for Pennsylvania |
| `/stations/{stationId}/observations/latest` | Current conditions from a weather station |

**Indiana County Coordinates:**
- Indiana, PA: `40.6215, -79.1525`
- NWS Office: Pittsburgh (PBZ)

**Rate Limits:** Free, no API key required, reasonable rate limits apply
**Documentation:** https://www.weather.gov/documentation/services-web-api

### 2. PennDOT Road Condition Reporting System (RCRS)

**Endpoints:**
| Endpoint | Purpose |
|----------|---------|
| `https://eventsdata.dot.pa.gov/winterConditions` | Winter road conditions statewide |
| `https://eventsdata.dot.pa.gov/liveEvents` | Active road events (accidents, closures) |

**GIS Map Server:** `https://gis.penndot.gov/gis/rest/services/winterconditions/winterconditions/MapServer`

**Access:** Requires credentials - submit Data Feed Request Form via PennDOT
**Alternative:** 511PA public data at https://www.511pa.com

---

## Features to Implement

### Phase 1: Core Weather (MVP)
- [ ] Current conditions display (temperature, humidity, wind, conditions)
- [ ] 7-day forecast with high/low temps
- [ ] Hourly forecast (next 24-48 hours)
- [ ] Location selector for Indiana County communities

### Phase 2: Alerts & Safety
- [ ] Active weather alerts/warnings for the region
- [ ] Severe weather notifications
- [ ] Road condition status (winter conditions)
- [ ] Road event alerts (closures, accidents)

### Phase 3: Enhanced Features
- [ ] Precipitation radar/maps
- [ ] Historical weather comparison
- [ ] Multiple location favorites
- [ ] Weather trends visualization

---

## Technical Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     FRONTEND                            │
│  (HTML/CSS/JS or React - Simple, responsive UI)         │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  Current    │  │  Forecast   │  │   Alerts    │     │
│  │  Weather    │  │  Display    │  │   Panel     │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                     BACKEND                             │
│              (User-managed API server)                  │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  API Routes                                      │   │
│  │  - GET /api/weather/current                      │   │
│  │  - GET /api/weather/forecast                     │   │
│  │  - GET /api/weather/hourly                       │   │
│  │  - GET /api/alerts                               │   │
│  │  - GET /api/roads/conditions                     │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  Services                                        │   │
│  │  - NOAA API client                               │   │
│  │  - PennDOT API client                            │   │
│  │  - Data caching layer                            │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                 EXTERNAL APIs                           │
│                                                         │
│   ┌──────────────────┐    ┌──────────────────┐         │
│   │  NOAA/NWS API    │    │  PennDOT RCRS    │         │
│   │  (weather.gov)   │    │  (eventsdata)    │         │
│   └──────────────────┘    └──────────────────┘         │
└─────────────────────────────────────────────────────────┘
```

---

## Indiana County Locations

| Community | Latitude | Longitude |
|-----------|----------|-----------|
| Indiana (Borough) | 40.6215 | -79.1525 |
| Homer City | 40.5423 | -79.1556 |
| Blairsville | 40.4312 | -79.2609 |
| Saltsburg | 40.4884 | -79.4517 |
| Clymer | 40.6687 | -79.0117 |
| Marion Center | 40.7687 | -79.0467 |

---

## Tech Stack Recommendations

### Frontend Options
- **Simple:** Vanilla HTML/CSS/JavaScript
- **Modern:** React or Vue.js with Tailwind CSS

### Backend Options
- **Node.js:** Express.js or Fastify
- **Python:** Flask or FastAPI

### Key Dependencies
- HTTP client for API calls (axios, fetch, requests)
- Caching solution (Redis, in-memory cache)
- Date/time handling (date-fns, dayjs)

---

## Implementation Priorities

### Must Have (MVP)
1. Backend service connecting to NOAA API
2. Current weather endpoint
3. 7-day forecast endpoint
4. Simple frontend displaying weather data

### Should Have
1. Hourly forecast
2. Weather alerts integration
3. Multiple location support

### Nice to Have
1. PennDOT road conditions (requires credential request)
2. Weather maps/radar
3. Push notifications for severe weather

---

## Next Steps

1. **Choose tech stack** - Decide on frontend framework and backend language
2. **Set up project structure** - Initialize package.json, folder structure
3. **Implement NOAA service** - Build API client for weather.gov
4. **Create basic endpoints** - Current weather, forecast routes
5. **Build frontend** - Simple responsive UI
6. **Request PennDOT credentials** - Submit data feed request form
7. **Add road conditions** - Integrate PennDOT data when credentials received

---

## Resources

- [NOAA NWS API Documentation](https://www.weather.gov/documentation/services-web-api)
- [NOAA API FAQ](https://weather-gov.github.io/api/general-faqs)
- [PennDOT Developer Resources](https://www.pa.gov/agencies/penndot/programs-and-doing-business/online-services/developer-resources-documentation-api)
- [511PA Road Conditions](https://www.511pa.com/)
- [PennDOT GIS Winter Conditions](https://gis.penndot.gov/gis/rest/services/winterconditions/winterconditions/MapServer)
