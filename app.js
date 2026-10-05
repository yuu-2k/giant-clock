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
let weatherRequestPending = false;

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

async function updateWeather() {
    if (!weatherCoordinates || weatherRequestPending || document.hidden) return;

    weatherRequestPending = true;
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
            cache: "no-store"
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

        const presentation = getWeatherPresentation(current.weather_code);
        const daylight = isDaylight(current, sunrise, sunset);

        document.getElementById("weather-location").textContent = "LOCAL WEATHER";
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
        weatherStatus.textContent = `Updated at ${current.time?.slice(11, 16) ?? "just now"}`;
        weatherRetry.hidden = true;

        document.body.classList.remove(...weatherClasses, "day", "night");
        document.body.classList.add(`weather-${presentation.effect}`, daylight ? "day" : "night");
        lastWeatherUpdate = Date.now();
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to retrieve weather.";
        setWeatherError(lastWeatherUpdate
            ? `Update failed · ${message}`
            : `${message} Check your connection.`);
    } finally {
        weatherRequestPending = false;
    }
}

function locateAndLoadWeather() {
    if (!navigator.geolocation) {
        setWeatherError("Geolocation is not available on this device.");
        return;
    }

    weatherRetry.hidden = true;
    weatherStatus.textContent = "Finding your location…";
    navigator.geolocation.getCurrentPosition(
        (position) => {
            weatherCoordinates = {
                latitude: position.coords.latitude,
                longitude: position.coords.longitude
            };
            updateWeather();
        },
        (error) => {
            const message = error.code === error.PERMISSION_DENIED
                ? "Allow location access to show the weather."
                : error.code === error.POSITION_UNAVAILABLE
                    ? "Your location is temporarily unavailable."
                    : "Location detection timed out.";
            setWeatherError(message);
        },
        { enableHighAccuracy: false, maximumAge: 300000, timeout: 12000 }
    );
}

updateClock();
setInterval(updateClock, 1000);
setInterval(updateWeather, 15 * 60 * 1000);

weatherRetry.addEventListener("click", locateAndLoadWeather);
locateAndLoadWeather();

document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastWeatherUpdate >= 15 * 60 * 1000) {
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
