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
const geolocationWatchdogDelay = 8000;
const requestTimeout = 12000;

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
        timezone: "auto",
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
setInterval(updateClock, 1000);
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
