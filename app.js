const clockElement = document.getElementById("clock");
const dateElement = document.getElementById("date");
const weatherStatus = document.getElementById("weather-status");
const weatherRetry = document.getElementById("weather-retry");
const weatherClasses = [
    "weather-sun",
    "weather-partly-cloudy",
    "weather-cloudy",
    "weather-fog",
    "weather-rain",
    "weather-snow",
    "weather-thunderstorm"
];

let weatherCoordinates = null;
let lastWeatherUpdate = 0;
let locationIsApproximate = false;
let locationResolvedPrecisely = false;
let locationAttempt = 0;
let ipLookupAttempt = 0;
let weatherRequestId = 0;
let weatherController = null;
let geolocationWatchdog = null;

const weatherRefreshInterval = 15 * 60 * 1000;
const ambientRefreshInterval = 5 * 60 * 1000;
const geolocationWatchdogDelay = 8000;
const requestTimeout = 12000;
let ambientWeather = {
    temperature: null,
    effect: null,
    sunrise: null,
    sunset: null
};
let lastAmbientStyle = "";

const ambientColorStops = [
    { temperature: 0, color: "#8ab9e5" },
    { temperature: 5, color: "#849ebd" },
    { temperature: 12, color: "#8997aa" },
    { temperature: 20, color: "#d4a985" },
    { temperature: 28, color: "#e3a078" },
    { temperature: 36, color: "#df896f" }
];

function updateClock() {
    const now = new Date();
    const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(now);
    const calendarDate = new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "long",
        year: "numeric"
    }).format(now);
    clockElement.textContent = new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
    }).format(now);
    clockElement.dateTime = now.toISOString();
    dateElement.textContent = `${weekday} · ${calendarDate}`.toLocaleUpperCase("en-GB");
}

function getWeatherPresentation(code) {
    if (code === 0) return { condition: "Clear sky", icon: "☼", effect: "sun" };
    if (code === 1 || code === 2) return { condition: "Partly cloudy", icon: "◒", effect: "partly-cloudy" };
    if (code === 3) return { condition: "Overcast", icon: "☁", effect: "cloudy" };
    if (code === 45 || code === 48) return { condition: "Fog", icon: "≋", effect: "fog" };
    if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) {
        return { condition: "Rain", icon: "☂", effect: "rain" };
    }
    if ([71, 73, 75, 77, 85, 86].includes(code)) {
        return { condition: "Snow", icon: "❄", effect: "snow" };
    }
    if ([95, 96, 99].includes(code)) {
        return { condition: "Thunderstorm", icon: "ϟ", effect: "thunderstorm" };
    }
    return { condition: "Variable conditions", icon: "◌", effect: "cloudy" };
}

function hexToRgb(hex) {
    const value = hex.replace("#", "");
    return {
        r: Number.parseInt(value.slice(0, 2), 16),
        g: Number.parseInt(value.slice(2, 4), 16),
        b: Number.parseInt(value.slice(4, 6), 16)
    };
}

function rgbToHex({ r, g, b }) {
    return `#${[r, g, b].map((value) =>
        Math.round(value).toString(16).padStart(2, "0")
    ).join("")}`;
}

function mixColors(first, second, amount) {
    const a = hexToRgb(first);
    const b = hexToRgb(second);
    return rgbToHex({
        r: a.r + (b.r - a.r) * amount,
        g: a.g + (b.g - a.g) * amount,
        b: a.b + (b.b - a.b) * amount
    });
}

function getTemperatureTint(temperature) {
    if (!Number.isFinite(temperature)) return "#8296b5";
    const boundedTemperature = Math.max(
        ambientColorStops[0].temperature,
        Math.min(ambientColorStops[ambientColorStops.length - 1].temperature, temperature)
    );
    const upperIndex = ambientColorStops.findIndex((stop) => stop.temperature >= boundedTemperature);
    if (upperIndex <= 0) return ambientColorStops[0].color;

    const lower = ambientColorStops[upperIndex - 1];
    const upper = ambientColorStops[upperIndex];
    const progress = (boundedTemperature - lower.temperature) / (upper.temperature - lower.temperature);
    return mixColors(lower.color, upper.color, progress);
}

function timeToMinutes(time, fallback) {
    if (typeof time !== "string" || !/^\d{2}:\d{2}$/.test(time)) return fallback;
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
}

function interpolateAmbient(left, right, progress) {
    const easedProgress = progress * progress * (3 - 2 * progress);
    return {
        color1: mixColors(left.color1, right.color1, easedProgress),
        color2: mixColors(left.color2, right.color2, easedProgress),
        color3: mixColors(left.color3, right.color3, easedProgress),
        glow: mixColors(left.glow, right.glow, easedProgress),
        intensity: left.intensity + (right.intensity - left.intensity) * easedProgress,
        stars: left.stars + (right.stars - left.stars) * easedProgress,
        glowX: left.glowX + (right.glowX - left.glowX) * easedProgress,
        glowY: left.glowY + (right.glowY - left.glowY) * easedProgress
    };
}

function toRgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getTimePalette(now, sunrise, sunset) {
    const sunriseMinute = timeToMinutes(sunrise, 6 * 60);
    let sunsetMinute = timeToMinutes(sunset, 18 * 60);
    if (sunsetMinute <= sunriseMinute) sunsetMinute = 18 * 60;

    const minuteOfDay = now.getHours() * 60 + now.getMinutes();
    const midday = (sunriseMinute + sunsetMinute) / 2;
    const night = { color1: "#070912", color2: "#101426", color3: "#17152a", glow: "#7988da", intensity: 0.38, stars: 0.62, glowX: 72, glowY: 30 };
    const anchors = [
        { minute: sunriseMinute - 120, ...night },
        { minute: sunriseMinute - 30, color1: "#0a1020", color2: "#19263a", color3: "#2b293e", glow: "#849bd4", intensity: 0.48, stars: 0.35, glowX: 50, glowY: 70 },
        { minute: sunriseMinute, color1: "#111a2b", color2: "#293d57", color3: "#493744", glow: "#f0ad99", intensity: 0.66, stars: 0.12, glowX: 50, glowY: 92 },
        { minute: sunriseMinute + 180, color1: "#111b2d", color2: "#304865", color3: "#51434c", glow: "#e7ad91", intensity: 0.76, stars: 0, glowX: 44, glowY: 78 },
        { minute: midday, color1: "#0a172b", color2: "#183453", color3: "#223850", glow: "#89baf0", intensity: 0.9, stars: 0, glowX: 50, glowY: 48 },
        { minute: sunsetMinute - 180, color1: "#171b31", color2: "#403950", color3: "#66464c", glow: "#f0b17f", intensity: 0.82, stars: 0, glowX: 68, glowY: 78 },
        { minute: sunsetMinute - 30, color1: "#111426", color2: "#30283d", color3: "#4d3042", glow: "#e5909d", intensity: 0.66, stars: 0.08, glowX: 54, glowY: 90 },
        { minute: sunsetMinute + 90, ...night },
        { minute: sunriseMinute + 1440 - 120, ...night }
    ].sort((a, b) => a.minute - b.minute);
    const timeline = [
        ...anchors.map((anchor) => ({ ...anchor, minute: anchor.minute - 1440 })),
        ...anchors,
        ...anchors.map((anchor) => ({ ...anchor, minute: anchor.minute + 1440 }))
    ].sort((a, b) => a.minute - b.minute);
    const currentMinute = minuteOfDay + 1440;
    const nextIndex = timeline.findIndex((anchor) => anchor.minute >= currentMinute);
    const left = timeline[Math.max(0, nextIndex - 1)];
    const right = timeline[nextIndex] || timeline[timeline.length - 1];
    const progress = right.minute === left.minute
        ? 0
        : (currentMinute - left.minute) / (right.minute - left.minute);

    return interpolateAmbient(left, right, Math.max(0, Math.min(1, progress)));
}

function applyAmbientBackground() {
    const palette = getTimePalette(
        new Date(),
        ambientWeather.sunrise,
        ambientWeather.sunset
    );
    const temperatureTint = getTemperatureTint(ambientWeather.temperature);
    const temperatureMix = Number.isFinite(ambientWeather.temperature) ? 0.14 : 0;

    palette.color1 = mixColors(palette.color1, temperatureTint, temperatureMix);
    palette.color2 = mixColors(palette.color2, temperatureTint, temperatureMix * 0.8);
    palette.color3 = mixColors(palette.color3, temperatureTint, temperatureMix * 0.65);
    palette.glow = mixColors(palette.glow, temperatureTint, temperatureMix * 0.65);

    const weatherTints = {
        rain: { color: "#526984", mix: 0.2, darken: 0.12, intensity: -0.1 },
        cloudy: { color: "#727e91", mix: 0.18, darken: 0, intensity: -0.05 },
        fog: { color: "#9aabba", mix: 0.2, darken: 0, intensity: 0.02 },
        sun: { color: "#f3c98f", mix: 0.12, darken: 0, intensity: 0.1 },
        "partly-cloudy": { color: "#a5b8d2", mix: 0.12, darken: 0, intensity: 0.04 },
        snow: { color: "#c0ddf2", mix: 0.19, darken: 0, intensity: 0.1 },
        thunderstorm: { color: "#425574", mix: 0.24, darken: 0.22, intensity: -0.16 }
    };
    const weatherTint = weatherTints[ambientWeather.effect];
    if (weatherTint) {
        palette.color1 = mixColors(palette.color1, "#080b12", weatherTint.darken);
        palette.color2 = mixColors(palette.color2, weatherTint.color, weatherTint.mix);
        palette.color3 = mixColors(palette.color3, weatherTint.color, weatherTint.mix);
        palette.glow = mixColors(palette.glow, weatherTint.color, weatherTint.mix);
        palette.intensity = Math.max(0.2, Math.min(1, palette.intensity + weatherTint.intensity));
    }

    const styles = {
        "--ambient-color-1": palette.color1,
        "--ambient-color-2": palette.color2,
        "--ambient-color-3": palette.color3,
        "--ambient-glow": toRgba(palette.glow, Math.min(0.28, palette.intensity * 0.22).toFixed(3)),
        "--ambient-intensity": palette.intensity.toFixed(3),
        "--ambient-stars": palette.stars.toFixed(3),
        "--ambient-glow-x": `${palette.glowX.toFixed(1)}%`,
        "--ambient-glow-y": `${palette.glowY.toFixed(1)}%`
    };
    const styleKey = JSON.stringify(styles);
    if (styleKey === lastAmbientStyle) return;

    lastAmbientStyle = styleKey;
    for (const [property, value] of Object.entries(styles)) {
        document.body.style.setProperty(property, value);
    }
}

function isDaylight(current, sunrise, sunset) {
    const currentTime = current.time?.slice(11, 16);
    const sunriseTime = sunrise?.slice(11, 16);
    const sunsetTime = sunset?.slice(11, 16);

    if (currentTime && sunriseTime && sunsetTime) {
        return currentTime >= sunriseTime && currentTime < sunsetTime;
    }
    return current.is_day === 1;
}

function setWeatherError(message, canRetry = true) {
    weatherStatus.textContent = message;
    weatherRetry.hidden = !canRetry;
}

function clearGeolocationWatchdog() {
    if (geolocationWatchdog !== null) {
        clearTimeout(geolocationWatchdog);
        geolocationWatchdog = null;
    }
}

function setLocation(coordinates, approximate, label) {
    weatherCoordinates = coordinates;
    locationIsApproximate = approximate;
    document.getElementById("weather-location").textContent = label.toLocaleUpperCase("en-GB");
}

async function locateByIp(attempt, reason) {
    if (attempt !== locationAttempt || ipLookupAttempt === attempt) return;

    ipLookupAttempt = attempt;
    weatherStatus.textContent = "Using approximate location…";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeout);

    try {
        const response = await fetch("https://ipwho.is/", {
            cache: "no-store",
            signal: controller.signal
        });
        if (!response.ok) {
            throw new Error(`IP location service unavailable (${response.status}).`);
        }

        const location = await response.json();
        if (!location.success || !Number.isFinite(location.latitude) ||
            !Number.isFinite(location.longitude)) {
            throw new Error(location.message || "IP location service returned invalid coordinates.");
        }
        if (attempt !== locationAttempt || locationResolvedPrecisely) return;

        const label = [location.city, location.country]
            .filter(Boolean)
            .join(", ") || "Approximate location";
        setLocation({
            latitude: location.latitude,
            longitude: location.longitude
        }, true, label);
        console.warn(`[weather] Using approximate IP location after ${reason}.`);
        await updateWeather();
    } catch (error) {
        if (attempt !== locationAttempt || locationResolvedPrecisely) return;
        console.error("[weather] IP location fallback failed.", error);
        const details = error instanceof Error
            ? error.name === "AbortError" ? "The request timed out." : error.message
            : "Unknown error.";
        setWeatherError(`Unable to locate you automatically (${details}). Check your connection or try again.`);
    } finally {
        clearTimeout(timeout);
    }
}

async function updateWeather() {
    if (!weatherCoordinates) return;
    if (document.hidden) {
        weatherStatus.textContent = "Weather updates when this tab is active.";
        return;
    }

    const requestId = ++weatherRequestId;
    weatherController?.abort();
    weatherController = new AbortController();
    const controller = weatherController;
    const timeout = setTimeout(() => controller.abort(), requestTimeout);
    weatherRetry.hidden = true;

    const params = new URLSearchParams({
        latitude: String(weatherCoordinates.latitude),
        longitude: String(weatherCoordinates.longitude),
        current: "temperature_2m,relative_humidity_2m,weather_code,is_day,wind_speed_10m",
        daily: "sunrise,sunset",
        temperature_unit: "celsius",
        wind_speed_unit: "kmh",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "auto",
        forecast_days: "1"
    });

    try {
        const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
            cache: "no-store",
            signal: controller.signal
        });
        if (!response.ok) {
            throw new Error(`Weather service unavailable (${response.status}).`);
        }

        const data = await response.json();
        const current = data.current;
        const sunrise = data.daily?.sunrise?.[0];
        const sunset = data.daily?.sunset?.[0];
        if (!current || !Number.isFinite(current.temperature_2m) ||
            !Number.isFinite(current.relative_humidity_2m) ||
            !Number.isFinite(current.wind_speed_10m) ||
            !Number.isFinite(current.weather_code)) {
            throw new Error("The weather service returned incomplete data.");
        }
        if (requestId !== weatherRequestId) return;

        const presentation = getWeatherPresentation(current.weather_code);
        const daylight = isDaylight(current, sunrise, sunset);
        ambientWeather = {
            temperature: current.temperature_2m,
            effect: presentation.effect,
            sunrise: sunrise?.slice(11, 16) ?? null,
            sunset: sunset?.slice(11, 16) ?? null
        };

        document.getElementById("weather-temperature").textContent =
            `${Math.round(current.temperature_2m)}°`;
        document.getElementById("weather-condition").textContent = presentation.condition;
        document.getElementById("weather-icon").textContent = presentation.icon;
        document.getElementById("weather-humidity").textContent =
            `${Math.round(current.relative_humidity_2m)}%`;
        document.getElementById("weather-wind").textContent =
            `${Math.round(current.wind_speed_10m)} km/h`;
        document.getElementById("sunrise").textContent = sunrise?.slice(11, 16) ?? "--:--";
        document.getElementById("sunset").textContent = sunset?.slice(11, 16) ?? "--:--";
        document.getElementById("ambient-label").textContent =
            `${daylight ? "DAY" : "NIGHT"} · ${presentation.condition.toLocaleUpperCase("en-GB")}`;
        weatherStatus.textContent = `Updated at ${current.time?.slice(11, 16) ?? "just now"}${locationIsApproximate ? " · approximate location" : ""}`;
        weatherRetry.hidden = true;

        document.body.classList.remove(...weatherClasses, "day", "night");
        document.body.classList.add(`weather-${presentation.effect}`, daylight ? "day" : "night");
        applyAmbientBackground();
        lastWeatherUpdate = Date.now();
    } catch (error) {
        if (requestId !== weatherRequestId) return;
        const message = error instanceof Error ? error.message : "Unable to retrieve weather.";
        console.error("[weather] Open-Meteo request failed.", error);
        setWeatherError(lastWeatherUpdate
            ? `Update failed · ${message}`
            : `Weather is unavailable · ${message}`);
    } finally {
        clearTimeout(timeout);
        if (weatherController === controller) weatherController = null;
    }
}

function locateAndLoadWeather() {
    const attempt = ++locationAttempt;
    locationResolvedPrecisely = false;
    clearGeolocationWatchdog();
    weatherRetry.hidden = true;
    weatherStatus.textContent = "Finding your location…";
    if (!window.isSecureContext) {
        console.warn("[weather] Geolocation may be blocked: this page is not running in a secure context. HTTPS or localhost is required.");
        locateByIp(attempt, "insecure context");
        return;
    }
    if (!navigator.geolocation) {
        console.warn("[weather] Browser geolocation is unsupported; using IP location.");
        locateByIp(attempt, "unsupported browser geolocation");
        return;
    }

    geolocationWatchdog = setTimeout(() => {
        console.warn("[weather] Geolocation permission or position did not respond; using IP location.");
        locateByIp(attempt, "geolocation timeout");
    }, geolocationWatchdogDelay);

    try {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                if (attempt !== locationAttempt) return;
                clearGeolocationWatchdog();
                if (!Number.isFinite(position.coords.latitude) ||
                    !Number.isFinite(position.coords.longitude)) {
                    console.error("[weather] Geolocation returned invalid coordinates.", position.coords);
                    locateByIp(attempt, "invalid browser coordinates");
                    return;
                }
                setLocation({
                    latitude: position.coords.latitude,
                    longitude: position.coords.longitude
                }, false, "Local weather");
                locationResolvedPrecisely = true;
                updateWeather();
            },
            (error) => {
                if (attempt !== locationAttempt) return;
                clearGeolocationWatchdog();
                const message = error.code === error.PERMISSION_DENIED
                    ? "Location permission denied"
                    : error.code === error.POSITION_UNAVAILABLE
                        ? "Position unavailable"
                        : error.code === error.TIMEOUT
                            ? "Geolocation timed out"
                            : "Geolocation failed";
                console.warn(`[weather] ${message} (${error.code}): ${error.message}`);
                locateByIp(attempt, message.toLowerCase());
            },
            { enableHighAccuracy: false, maximumAge: 300000, timeout: requestTimeout }
        );
    } catch (error) {
        clearGeolocationWatchdog();
        console.error("[weather] Could not start browser geolocation.", error);
        locateByIp(attempt, "geolocation could not start");
    }
}

updateClock();
applyAmbientBackground();
setInterval(updateClock, 1000);
setInterval(applyAmbientBackground, ambientRefreshInterval);
setInterval(updateWeather, weatherRefreshInterval);

weatherRetry.addEventListener("click", () => {
    if (weatherCoordinates) updateWeather();
    else locateAndLoadWeather();
});
locateAndLoadWeather();

document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastWeatherUpdate >= weatherRefreshInterval) {
        if (weatherCoordinates) updateWeather();
        else locateAndLoadWeather();
    }
});

const fullscreenButton = document.getElementById("fullscreen");
fullscreenButton.addEventListener("click", async () => {
    try {
        if (document.fullscreenElement) {
            await document.exitFullscreen();
        } else {
            await document.documentElement.requestFullscreen();
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : "Fullscreen is unavailable.";
        weatherStatus.textContent = `Fullscreen unavailable · ${message}`;
    }
});

document.addEventListener("fullscreenchange", () => {
    const isFullscreen = Boolean(document.fullscreenElement);
    fullscreenButton.setAttribute("aria-label", isFullscreen ? "Exit fullscreen" : "Enter fullscreen");
    fullscreenButton.title = isFullscreen ? "Exit fullscreen" : "Fullscreen";
});
