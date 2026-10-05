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
const ambientRefreshInterval = 60 * 1000;
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
    { temperature: 0, color: "#91c8ee" },
    { temperature: 5, color: "#8eabc9" },
    { temperature: 12, color: "#aab8c5" },
    { temperature: 20, color: "#e0c3a4" },
    { temperature: 28, color: "#edbb91" },
    { temperature: 35, color: "#e9a17f" },
    { temperature: 42, color: "#df9278" }
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
    const night = { color1: "#080d19", color2: "#111a2c", color3: "#1c1a31", glow: "#899fe0", intensity: 0.48, stars: 0.62, glowX: 76, glowY: 24 };
    const anchors = [
        { minute: sunriseMinute - 90, ...night },
        { minute: sunriseMinute, color1: "#23374e", color2: "#55718c", color3: "#895d66", glow: "#f2bd9c", intensity: 0.69, stars: 0.12, glowX: 48, glowY: 94 },
        { minute: sunriseMinute + 120, color1: "#1c4771", color2: "#458bb5", color3: "#a17c78", glow: "#f3c9a0", intensity: 0.82, stars: 0, glowX: 40, glowY: 78 },
        { minute: midday, color1: "#164b7d", color2: "#348fc0", color3: "#27628d", glow: "#91e2f5", intensity: 1, stars: 0, glowX: 50, glowY: 48 },
        { minute: sunsetMinute - 180, color1: "#24517b", color2: "#4b85a9", color3: "#9a727c", glow: "#f1c097", intensity: 0.84, stars: 0, glowX: 67, glowY: 77 },
        { minute: sunsetMinute - 60, color1: "#392e4e", color2: "#87536a", color3: "#b36d69", glow: "#ffd0a1", intensity: 0.72, stars: 0, glowX: 70, glowY: 91 },
        { minute: sunsetMinute, color1: "#24243e", color2: "#604762", color3: "#a65e68", glow: "#f0a28e", intensity: 0.61, stars: 0.06, glowX: 66, glowY: 95 },
        { minute: sunsetMinute + 90, ...night },
        { minute: sunriseMinute + 1350, ...night }
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
    const solarTime = timeToMinutes(ambientWeather.sunrise, 6 * 60);
    const sunsetTime = timeToMinutes(ambientWeather.sunset, 18 * 60);
    const minuteOfDay = new Date().getHours() * 60 + new Date().getMinutes();
    const isDaylight = minuteOfDay >= solarTime && minuteOfDay < sunsetTime;
    const weatherPalettes = {
        sun: isDaylight
            ? { color1: "#164b7d", color2: "#348fc0", color3: "#27628d", glow: "#91e2f5", intensity: 0.87, stars: 0 }
            : { color1: "#080d19", color2: "#111a2c", color3: "#1c1a31", glow: "#899fe0", intensity: 0.48, stars: 0.62 },
        "partly-cloudy": isDaylight
            ? { color1: "#294a6d", color2: "#6487a5", color3: "#55748f", glow: "#b4d9eb", intensity: 0.78, stars: 0 }
            : { color1: "#0a1020", color2: "#19243a", color3: "#24263c", glow: "#9aaddd", intensity: 0.44, stars: 0.56 },
        cloudy: isDaylight
            ? { color1: "#465b70", color2: "#8197a8", color3: "#647c8c", glow: "#c3d1d6", intensity: 0.78, stars: 0 }
            : { color1: "#101722", color2: "#242e3d", color3: "#2c3040", glow: "#9daec6", intensity: 0.4, stars: 0.48 },
        fog: isDaylight
            ? { color1: "#657983", color2: "#a5b4b6", color3: "#879a9e", glow: "#dce8e4", intensity: 0.7, stars: 0 }
            : { color1: "#202a35", color2: "#3b4854", color3: "#39414f", glow: "#b8c8d3", intensity: 0.4, stars: 0.36 },
        rain: isDaylight
            ? { color1: "#203953", color2: "#435f77", color3: "#384d63", glow: "#91b2c5", intensity: 0.65, stars: 0 }
            : { color1: "#080d17", color2: "#121d2b", color3: "#202537", glow: "#728aa9", intensity: 0.35, stars: 0.3 },
        snow: isDaylight
            ? { color1: "#557b9a", color2: "#93b7cc", color3: "#789bad", glow: "#e1f2f5", intensity: 0.88, stars: 0 }
            : { color1: "#182a3b", color2: "#314c64", color3: "#35415a", glow: "#bdd8ec", intensity: 0.52, stars: 0.36 },
        thunderstorm: isDaylight
            ? { color1: "#18283d", color2: "#34475c", color3: "#30364c", glow: "#7d91ad", intensity: 0.48, stars: 0 }
            : { color1: "#070a13", color2: "#101725", color3: "#191b2d", glow: "#7186b5", intensity: 0.28, stars: 0.18 }
    };
    const weatherPalette = weatherPalettes[ambientWeather.effect];
    if (weatherPalette) {
        Object.assign(palette, weatherPalette);
        if (isDaylight && (ambientWeather.effect === "sun" || ambientWeather.effect === "partly-cloudy")) {
            const sunProgress = Math.max(0, Math.min(1, (minuteOfDay - solarTime) / Math.max(1, sunsetTime - solarTime)));
            if (sunProgress < 0.16) {
                const sunriseBlend = 1 - sunProgress / 0.16;
                palette.color2 = mixColors(palette.color2, "#d5a98d", sunriseBlend * 0.3);
                palette.glow = mixColors(palette.glow, "#ffd1a0", sunriseBlend * 0.35);
                palette.glowY = 94 - sunriseBlend * 12;
            } else if (sunProgress > 0.78) {
                const sunsetBlend = (sunProgress - 0.78) / 0.22;
                palette.color2 = mixColors(palette.color2, "#8b6178", sunsetBlend * 0.38);
                palette.color3 = mixColors(palette.color3, "#b36c77", sunsetBlend * 0.3);
                palette.glow = mixColors(palette.glow, "#f2ae99", sunsetBlend * 0.4);
                palette.glowY = 82 + sunsetBlend * 12;
                palette.intensity -= sunsetBlend * 0.14;
            }
        }
        if (ambientWeather.effect === "sun" || ambientWeather.effect === "partly-cloudy") {
            const solarProgress = Math.max(0, Math.min(1, (minuteOfDay - solarTime) / Math.max(1, sunsetTime - solarTime)));
            const noonBoost = Math.max(0, 1 - Math.abs(solarProgress - 0.5) * 2);
            palette.intensity = Math.min(1, palette.intensity + noonBoost * 0.13);
        }
    }

    const temperatureTint = getTemperatureTint(ambientWeather.temperature);
    const temperatureMix = Number.isFinite(ambientWeather.temperature) ? 0.1 : 0;
    palette.color1 = mixColors(palette.color1, temperatureTint, temperatureMix * 0.5);
    palette.color2 = mixColors(palette.color2, temperatureTint, temperatureMix);
    palette.color3 = mixColors(palette.color3, temperatureTint, temperatureMix * 0.7);
    palette.glow = mixColors(palette.glow, temperatureTint, temperatureMix * 0.45);
    if (Number.isFinite(ambientWeather.temperature)) {
        const temperatureProgress = Math.max(0, Math.min(1, (ambientWeather.temperature - 5) / 30));
        const temperatureBrightness = -0.025 + temperatureProgress * 0.06;
        palette.intensity = Math.max(0.2, Math.min(1, palette.intensity + temperatureBrightness));
    }

    const styles = {
        "--ambient-color-1": palette.color1,
        "--ambient-color-2": palette.color2,
        "--ambient-color-3": palette.color3,
        "--ambient-glow": toRgba(palette.glow, (isDaylight ? 0.22 + palette.intensity * 0.28 : palette.intensity * 0.2).toFixed(3)),
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
